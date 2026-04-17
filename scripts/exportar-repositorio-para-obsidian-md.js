/**
 * Exporta o repositório para uma cópia 100% Markdown dentro do Obsidian.
 *
 * A ideia deste script é transformar cada arquivo do projeto em um `.md`
 * legível no próprio Obsidian, preservando a estrutura de pastas do repositório
 * e gerando índices de navegação. O destino padrão é a pasta
 * `Documents/Obsidian/obsidian/Misc/DePix/codigo`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_REPOSITORY_ROOT = process.cwd();
const DEFAULT_TARGET_DIRECTORY = path.join(
  os.homedir(),
  "Documents",
  "Obsidian",
  "obsidian",
  "Misc",
  "DePix",
  "codigo",
);

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".wrangler",
  "node_modules",
]);

const EXCLUDED_FILES = new Set([
  ".wrangler-dev.err.log",
  ".wrangler-dev.out.log",
]);

/**
 * Lê um argumento nomeado da linha de comando no formato `--nome valor`.
 *
 * @param {string[]} commandLineArguments Lista de argumentos recebidos pelo Node.
 * @param {string} argumentName Nome do argumento a ser procurado.
 * @returns {string | null} Valor encontrado ou `null` quando o argumento não existe.
 */
function readNamedArgument(commandLineArguments, argumentName) {
  const argumentIndex = commandLineArguments.indexOf(argumentName);

  if (argumentIndex === -1) {
    return null;
  }

  return commandLineArguments[argumentIndex + 1] ?? null;
}

/**
 * Resolve a configuração final da exportação combinando defaults e CLI.
 *
 * @param {string[]} commandLineArguments Lista de argumentos recebidos pelo Node.
 * @returns {{ repositoryRoot: string, targetDirectory: string }} Configuração final da execução.
 */
function resolveExportConfiguration(commandLineArguments) {
  const repositoryRootArgument = readNamedArgument(commandLineArguments, "--source");
  const targetDirectoryArgument = readNamedArgument(commandLineArguments, "--target");

  return {
    repositoryRoot: path.resolve(repositoryRootArgument ?? DEFAULT_REPOSITORY_ROOT),
    targetDirectory: path.resolve(targetDirectoryArgument ?? DEFAULT_TARGET_DIRECTORY),
  };
}

/**
 * Garante que a pasta de destino exista antes da exportação começar.
 *
 * @param {string} directoryPath Caminho da pasta a verificar.
 * @returns {Promise<void>} Promessa resolvida quando a verificação termina.
 */
async function assertDirectoryExists(directoryPath) {
  const directoryStats = await fs.stat(directoryPath).catch(() => null);

  if (!directoryStats || !directoryStats.isDirectory()) {
    throw new Error(`A pasta de destino do Obsidian não existe: ${directoryPath}`);
  }
}

/**
 * Remove a exportação anterior para evitar lixo entre uma geração e outra.
 *
 * @param {string} directoryPath Caminho da pasta a ser recriada.
 * @returns {Promise<void>} Promessa resolvida quando a pasta está limpa.
 */
async function resetDirectory(directoryPath) {
  await fs.rm(directoryPath, { recursive: true, force: true });
  await fs.mkdir(directoryPath, { recursive: true });
}

/**
 * Descobre todos os arquivos do repositório que devem virar Markdown.
 *
 * @param {string} currentDirectory Diretório atual da varredura recursiva.
 * @returns {Promise<string[]>} Lista absoluta dos arquivos encontrados.
 */
async function collectRepositoryFiles(currentDirectory) {
  const directoryEntries = await fs.readdir(currentDirectory, { withFileTypes: true });
  const discoveredFiles = [];

  for (const entry of directoryEntries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    if (entry.isFile() && EXCLUDED_FILES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDirectory, entry.name);

    if (entry.isDirectory()) {
      discoveredFiles.push(...(await collectRepositoryFiles(absolutePath)));
      continue;
    }

    if (entry.isFile()) {
      discoveredFiles.push(absolutePath);
    }
  }

  return discoveredFiles.sort((left, right) => left.localeCompare(right));
}

/**
 * Converte o nome real do arquivo em um nome `.md` amigável para o Obsidian.
 *
 * @param {string} fileName Nome original do arquivo.
 * @returns {string} Nome final do arquivo exportado em Markdown.
 */
function toMarkdownFileName(fileName) {
  if (fileName.toLowerCase().endsWith(".md")) {
    return fileName;
  }

  if (fileName.startsWith(".")) {
    return `dot-${fileName.slice(1)}.md`;
  }

  return `${fileName}.md`;
}

/**
 * Mapeia extensões de arquivo para linguagens de bloco de código Markdown.
 *
 * @param {string} filePath Caminho relativo do arquivo original.
 * @returns {string} Linguagem apropriada para a fence do Markdown.
 */
function detectCodeFenceLanguage(filePath) {
  if (filePath.endsWith(".js")) return "javascript";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".jsonc")) return "json";
  if (filePath.endsWith(".sql")) return "sql";
  if (filePath.endsWith(".d.ts")) return "typescript";
  if (filePath.endsWith(".cmd")) return "bat";
  if (filePath.endsWith(".ps1")) return "powershell";
  if (filePath.endsWith(".md")) return "markdown";

  return "text";
}

/**
 * Monta o conteúdo Markdown de um arquivo de código qualquer.
 *
 * @param {string} relativePath Caminho relativo original dentro do repositório.
 * @param {string} fileContents Conteúdo bruto do arquivo.
 * @returns {string} Conteúdo final em Markdown para o Obsidian.
 */
function buildMarkdownCopy(relativePath, fileContents) {
  const codeFenceLanguage = detectCodeFenceLanguage(relativePath);
  const codeFence = "````";

  return [
    `# ${path.basename(relativePath)}`,
    "",
    `Origem no repositório: \`${relativePath.replace(/\\/g, "/")}\``,
    "",
    `${codeFence}${codeFenceLanguage}`,
    fileContents,
    codeFence,
    "",
  ].join("\n");
}

/**
 * Monta o conteúdo exportado para arquivos que já são Markdown no repositório.
 *
 * @param {string} relativePath Caminho relativo original dentro do repositório.
 * @param {string} fileContents Conteúdo bruto do arquivo.
 * @returns {string} Conteúdo final em Markdown preservando a leitura natural.
 */
function buildMarkdownDocumentCopy(relativePath, fileContents) {
  return [
    `> Origem no repositório: \`${relativePath.replace(/\\/g, "/")}\``,
    "",
    fileContents,
    "",
  ].join("\n");
}

/**
 * Resolve o caminho final do arquivo exportado dentro da estrutura do Obsidian.
 *
 * @param {string} targetRoot Diretório raiz da exportação.
 * @param {string} relativePath Caminho relativo original do arquivo.
 * @returns {string} Caminho absoluto do Markdown exportado.
 */
function getExportPath(targetRoot, relativePath) {
  const relativeDirectory = path.dirname(relativePath);
  const targetDirectory = relativeDirectory === "." ? targetRoot : path.join(targetRoot, relativeDirectory);

  return path.join(targetDirectory, toMarkdownFileName(path.basename(relativePath)));
}

/**
 * Garante que o diretório pai do arquivo exportado exista.
 *
 * @param {string} filePath Caminho final do arquivo exportado.
 * @returns {Promise<void>} Promessa resolvida quando a pasta existe.
 */
async function ensureParentDirectory(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Exporta um arquivo do repositório para sua versão Markdown no Obsidian.
 *
 * @param {string} targetRoot Diretório raiz da exportação.
 * @param {string} sourceFilePath Caminho absoluto do arquivo original.
 * @returns {Promise<{ relativePath: string, exportPath: string }>} Metadados do arquivo exportado.
 */
async function exportFileToMarkdown(repositoryRoot, targetRoot, sourceFilePath) {
  const relativePath = path.relative(repositoryRoot, sourceFilePath);
  const sourceContents = await fs.readFile(sourceFilePath, "utf8");
  const exportPath = getExportPath(targetRoot, relativePath);
  const markdownContents = relativePath.toLowerCase().endsWith(".md")
    ? buildMarkdownDocumentCopy(relativePath, sourceContents)
    : buildMarkdownCopy(relativePath, sourceContents);

  await ensureParentDirectory(exportPath);
  await fs.writeFile(exportPath, markdownContents, "utf8");

  return {
    relativePath,
    exportPath,
  };
}

/**
 * Agrupa os arquivos exportados por diretório para gerar índices navegáveis.
 *
 * @param {Array<{ relativePath: string, exportPath: string }>} exportedFiles Arquivos já exportados.
 * @returns {Map<string, Array<{ relativePath: string, exportPath: string }>>} Estrutura agrupada por pasta.
 */
function groupFilesByDirectory(exportedFiles) {
  const groupedFiles = new Map();

  for (const exportedFile of exportedFiles) {
    const relativeDirectory = path.dirname(exportedFile.relativePath) === "."
      ? ""
      : path.dirname(exportedFile.relativePath);

    if (!groupedFiles.has(relativeDirectory)) {
      groupedFiles.set(relativeDirectory, []);
    }

    groupedFiles.get(relativeDirectory).push(exportedFile);
  }

  return groupedFiles;
}

/**
 * Lista subdiretórios imediatos para compor os índices do Obsidian.
 *
 * @param {string} directoryPath Diretório absoluto a inspecionar.
 * @returns {Promise<string[]>} Subpastas imediatas encontradas.
 */
async function listImmediateSubdirectories(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Gera o conteúdo de um arquivo `INDEX.md` para uma pasta exportada.
 *
 * @param {string} repositoryRoot Diretório raiz real do repositório.
 * @param {string} relativeDirectory Caminho relativo da pasta atual.
 * @param {string[]} subdirectories Subpastas diretas da pasta atual.
 * @param {Array<{ relativePath: string, exportPath: string }>} files Arquivos exportados da pasta atual.
 * @returns {string} Conteúdo Markdown do índice.
 */
function buildDirectoryIndexContent(repositoryRoot, relativeDirectory, subdirectories, files) {
  const displayName = relativeDirectory === "" ? "codigo" : `codigo/${relativeDirectory.replace(/\\/g, "/")}`;
  const lines = [`# ${displayName}`, ""];

  if (relativeDirectory !== "") {
    const parentDirectory = path.dirname(relativeDirectory);
    const parentIndexPath = parentDirectory === "." ? "../INDEX.md" : "../INDEX.md";
    lines.push(`[Voltar para a pasta anterior](${parentIndexPath})`, "");
  }

  if (subdirectories.length > 0) {
    lines.push("## Pastas", "");

    for (const subdirectory of subdirectories) {
      lines.push(`- [${subdirectory}](${subdirectory}/INDEX.md)`);
    }

    lines.push("");
  }

  if (files.length > 0) {
    lines.push("## Arquivos", "");

    for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
      const fileName = path.basename(file.exportPath);
      lines.push(`- [${fileName}](${fileName})`);
    }

    lines.push("");
  }

  lines.push(
    `Exportado automaticamente em ${new Date().toLocaleString("pt-BR")}.`,
    "",
    `Raiz original do repositório: \`${repositoryRoot.replace(/\\/g, "/")}\``,
    "",
  );

  return lines.join("\n");
}

/**
 * Gera arquivos `INDEX.md` em todas as pastas da exportação.
 *
 * @param {string} repositoryRoot Diretório raiz real do repositório.
 * @param {string} targetRoot Diretório raiz da exportação.
 * @param {Array<{ relativePath: string, exportPath: string }>} exportedFiles Arquivos já exportados.
 * @returns {Promise<void>} Promessa resolvida quando todos os índices existem.
 */
async function writeDirectoryIndexes(repositoryRoot, targetRoot, exportedFiles) {
  const filesByDirectory = groupFilesByDirectory(exportedFiles);
  const directoriesToIndex = new Set(["", ...filesByDirectory.keys()]);

  for (const relativeDirectory of directoriesToIndex) {
    const absoluteDirectory = relativeDirectory === ""
      ? targetRoot
      : path.join(targetRoot, relativeDirectory);
    const files = filesByDirectory.get(relativeDirectory) ?? [];
    const subdirectories = await listImmediateSubdirectories(absoluteDirectory);
    const indexContents = buildDirectoryIndexContent(repositoryRoot, relativeDirectory, subdirectories, files);
    const indexPath = path.join(absoluteDirectory, "INDEX.md");

    await fs.writeFile(indexPath, indexContents, "utf8");
  }
}

/**
 * Executa a exportação completa do repositório para Markdown no Obsidian.
 *
 * @param {string} targetDirectory Diretório final da exportação.
 * @param {string} repositoryRoot Diretório raiz real do repositório.
 * @returns {Promise<void>} Promessa resolvida quando a exportação termina.
 */
async function exportRepositoryToObsidian(targetDirectory, repositoryRoot) {
  await assertDirectoryExists(repositoryRoot);
  await assertDirectoryExists(path.dirname(targetDirectory));
  await resetDirectory(targetDirectory);

  const repositoryFiles = await collectRepositoryFiles(repositoryRoot);
  const exportedFiles = [];

  for (const repositoryFile of repositoryFiles) {
    exportedFiles.push(await exportFileToMarkdown(repositoryRoot, targetDirectory, repositoryFile));
  }

  await writeDirectoryIndexes(repositoryRoot, targetDirectory, exportedFiles);

  console.log(`Repositório de origem: ${repositoryRoot}`);
  console.log(`Exportação concluída em: ${targetDirectory}`);
  console.log(`Arquivos exportados: ${exportedFiles.length}`);
}

/**
 * Executa a exportação usando a configuração resolvida a partir da CLI.
 *
 * @returns {Promise<void>} Promessa resolvida quando a execução termina.
 */
async function run() {
  const exportConfiguration = resolveExportConfiguration(process.argv.slice(2));

  await exportRepositoryToObsidian(exportConfiguration.targetDirectory, exportConfiguration.repositoryRoot);
}

run().catch((error) => {
  console.error("Falha ao exportar o repositório para o Obsidian.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
