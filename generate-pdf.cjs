const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const hljs = require('highlight.js');
const { execSync } = require('child_process');
const ignore = require('ignore');
const { isBinaryFileSync } = require('isbinaryfile');
const { parseArgs } = require('node:util');

const DEFAULT_MAX_FILE_SIZE = 100 * 1024; // 100KB

const fileIdMap = new Map();
const ignoreCache = new Map();

// Emoji regex pattern - matches most Unicode emojis
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}-\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}-\u{26AB}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}-\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}-\u{2734}\u{2744}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}-\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

// Remove emojis from text
function removeEmojis(text) {
  return text.replace(EMOJI_REGEX, '');
}

// Escape special LaTeX characters
function escapeLatex(text) {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/</g, '\\textless{}')
    .replace(/>/g, '\\textgreater{}')
    .replace(/\|/g, '\\textbar{}');
}

// Convert basic markdown to LaTeX (for .md files to be rendered as-is)
function markdownToLatex(markdown) {
  let latex = markdown;

  // Remove emojis first
  latex = removeEmojis(latex);

  // Headers
  latex = latex.replace(/^######\s+(.+)$/gm, '\\subparagraph{$1}');
  latex = latex.replace(/^#####\s+(.+)$/gm, '\\paragraph{$1}');
  latex = latex.replace(/^####\s+(.+)$/gm, '\\subsubsection{$1}');
  latex = latex.replace(/^###\s+(.+)$/gm, '\\subsection{$1}');
  latex = latex.replace(/^##\s+(.+)$/gm, '\\section{$1}');
  latex = latex.replace(/^#\s+(.+)$/gm, '\\chapter{$1}');

  // Bold and italic
  latex = latex.replace(/\*\*\*(.+?)\*\*\*/g, '\\textbf{\\textit{$1}}');
  latex = latex.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}');
  latex = latex.replace(/\*(.+?)\*/g, '\\textit{$1}');
  latex = latex.replace(/___(.+?)___/g, '\\textbf{\\textit{$1}}');
  latex = latex.replace(/__(.+?)__/g, '\\textbf{$1}');
  latex = latex.replace(/_(.+?)_/g, '\\textit{$1}');

  // Inline code
  latex = latex.replace(/`([^`]+)`/g, '\\texttt{$1}');

  // Code blocks - keep as verbatim
  latex = latex.replace(/```[\w]*\n([\s\S]*?)```/g, '\\begin{verbatim}\n$1\\end{verbatim}');

  // Links: [text](url) -> \href{url}{text}
  latex = latex.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '\\href{$2}{$1}');

  // Images: ![alt](url) -> \includegraphics{url} with comment for alt
  latex = latex.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '% Image: $1\n\\includegraphics[width=\\textwidth]{$2}');

  // Unordered lists
  latex = latex.replace(/^[\*\-]\s+(.+)$/gm, '\\item $1');

  // Ordered lists (basic)
  latex = latex.replace(/^\d+\.\s+(.+)$/gm, '\\item $1');

  // Blockquotes
  latex = latex.replace(/^>\s+(.+)$/gm, '\\begin{quote}$1\\end{quote}');

  // Horizontal rules
  latex = latex.replace(/^[-*_]{3,}$/gm, '\\hrulefill');

  return latex;
}

// Map language to listings language name
function getListingsLanguage(extension) {
  const languageMap = {
    'js': 'JavaScript',
    'jsx': 'JavaScript',
    'ts': 'JavaScript',
    'tsx': 'JavaScript',
    'py': 'Python',
    'java': 'Java',
    'cpp': 'C++',
    'c': 'C',
    'go': 'Go',
    'rs': 'Rust',
    'php': 'PHP',
    'rb': 'Ruby',
    'cs': 'C',
    'css': 'CSS',
    'scss': 'CSS',
    'less': 'CSS',
    'html': 'HTML',
    'xml': 'XML',
    'json': 'JSON',
    'yaml': 'YAML',
    'yml': 'YAML',
    'sh': 'bash',
    'bash': 'bash',
    'sql': 'SQL'
  };

  return languageMap[extension.toLowerCase()] || '';
}

const customStyle = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf-8');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse command line arguments
function parseCLIArgs() {
  const options = {
    input: {
      type: 'string',
      short: 'i',
      default: './src'
    },
    output: {
      type: 'string',
      short: 'o'
    },
    'max-size': {
      type: 'string',
      short: 's',
      default: '100'
    },
    'files-per-pdf': {
      type: 'string',
      short: 'f',
      default: '50'
    },
    format: {
      type: 'string',
      short: 'F',
      default: 'pdf'
    },
    help: {
      type: 'boolean',
      short: 'h',
      default: false
    },
    version: {
      type: 'boolean',
      short: 'v',
      default: false
    }
  };

  try {
    const { values, positionals } = parseArgs({
      options,
      allowPositionals: true,
      strict: true
    });

    // If positional argument provided, use it as input
    if (positionals.length > 0) {
      values.input = positionals[0];
    }

    return values;
  } catch (error) {
    console.error('Error parsing arguments:', error.message);
    showHelp();
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
code-to-pdf - Convert code to PDF with syntax highlighting

Usage:
  node generate-pdf.cjs [options] [input]
  node generate-pdf.cjs <input>

Arguments:
  input                    Path to local directory or GitHub repository
                          (e.g., ./src, owner/repo, https://github.com/owner/repo)

Options:
  -i, --input <path>       Input path (default: ./src)
  -o, --output <path>      Output file path (auto-generated if not specified)
  -s, --max-size <kb>      Maximum file size in KB to include (default: 100)
  -f, --files-per-pdf <n>  Maximum files per PDF for pagination (default: 50)
  -F, --format <format>    Output format: pdf or latex (default: pdf)
  -h, --help               Show this help message
  -v, --version            Show version information

Examples:
  node generate-pdf.cjs ./src
  node generate-pdf.cjs -i ./src -o output.pdf
  node generate-pdf.cjs owner/repo
  node generate-pdf.cjs https://github.com/owner/repo -s 200
  node generate-pdf.cjs -i owner/repo --max-size 150 --files-per-pdf 100
  node generate-pdf.cjs ./src -F latex -o code.tex

Features:
  - Respects .gitignore files (including nested .gitignore files)
  - Automatically skips binary files
  - Syntax highlighting for multiple languages
  - Generates clickable table of contents
  - Automatic pagination for large repositories
`);
}

function showVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  console.log(`code-to-pdf v${packageJson.version || '1.0.0'}`);
}

function parseInput(input) {
  if (fs.existsSync(input)) {
    return {
      type: 'local',
      path: input
    };
  }
  const githubPatterns = [
    /^https:\/\/github\.com\/([^/]+\/[^/]+)$/,          // https://github.com/owner/repo
    /^git@github\.com:([^/]+\/[^/]+)\.git$/,            // git@github.com:owner/repo.git
    /^([^/]+\/[^/]+)$/                                  // owner/repo
  ];

  for (const pattern of githubPatterns) {
    const match = input.match(pattern);
    if (match) {
      return {
        type: 'github',
        repo: match[1].replace('.git', '')
      };
    }
  }

  return {
    type: 'local',
    path: input
  };
}

function generateFileId(filePath) {
  if (!fileIdMap.has(filePath)) {
    const hash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 8);
    fileIdMap.set(filePath, `file-${hash}`);
  }
  return fileIdMap.get(filePath);
}

// Get ignore instance for a specific directory (with caching)
function getIgnoreForDir(dirPath) {
  if (ignoreCache.has(dirPath)) {
    return ignoreCache.get(dirPath);
  }

  const ig = ignore();
  const gitignorePath = path.join(dirPath, '.gitignore');

  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    ig.add(gitignoreContent);
  }

  ignoreCache.set(dirPath, ig);
  return ig;
}

// Check if a file path should be ignored based on gitignore rules
// This function checks .gitignore files in all parent directories
function shouldIgnore(filePath, baseDir) {
  // Always apply default ignores
  const defaultIg = ignore();
  defaultIg.add(['.git', 'node_modules', 'dist', '.vscode', 'Cargo.lock', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml', '.gitignore']);
  const relativeFromBase = path.relative(baseDir, filePath);
  if (defaultIg.ignores(relativeFromBase)) {
    return true;
  }

  // Walk up the directory tree and check .gitignore files in each directory
  let currentDir = path.dirname(filePath);

  while (currentDir.startsWith(baseDir) || currentDir === baseDir) {
    const ig = getIgnoreForDir(currentDir);
    const relativePath = path.relative(currentDir, filePath);

    // Only check if relativePath is not empty (i.e., file is not in currentDir itself)
    if (relativePath && ig.ignores(relativePath)) {
      return true;
    }

    if (currentDir === baseDir) break;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // Reached filesystem root
    currentDir = parentDir;
  }

  return false;
}

// Check if a file is binary
function isBinaryFile(filePath) {
  try {
    return isBinaryFileSync(filePath);
  } catch (error) {
    // If we can't determine, assume it's not binary
    return false;
  }
}

async function cloneRepo(repo) {
  const tempDir = path.join(process.cwd(), repo.replace('/', '-'));
  console.log(`Cloning repository: ${repo}...`);

  try {
    if (fs.existsSync(tempDir)) {
      for (let i = 0; i < 3; i++) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
          break;
        } catch (err) {
          if (i === 2) throw err;
          await sleep(1000);
        }
      }
    }

    execSync(`git clone https://github.com/${repo}.git ${tempDir}`, {
      stdio: 'inherit'
    });

    return tempDir;
  } catch (error) {
    console.error('Failed to clone repository:', error.message);
    process.exit(1);
  }
}

function generateDirectoryTree(dir, baseDir, maxFileSize, prefix = '') {
  let tree = '';
  const files = fs.readdirSync(dir);

  files.forEach((file, index) => {
    const fullPath = path.join(dir, file);

    // Skip if ignored by gitignore or binary
    if (shouldIgnore(fullPath, baseDir)) {
      return;
    }

    const isLast = index === files.length - 1;
    const connector = isLast ? '+-- ' : '|-- ';

    if (fs.statSync(fullPath).isDirectory()) {
      tree += `${prefix}${connector}${file}/\n`;
      tree += generateDirectoryTree(fullPath, baseDir, maxFileSize, prefix + (isLast ? '    ' : '|   '));
    } else {
      // Skip binary files
      if (isBinaryFile(fullPath)) {
        tree += `${prefix}${connector}${file} (binary, skipped)\n`;
        return;
      }

      const stats = fs.statSync(fullPath);
      if (stats.size <= maxFileSize) {
        const fileId = generateFileId(fullPath);
        tree += `${prefix}${connector}<a href="#${fileId}">${file}</a>\n`;
      } else {
        tree += `${prefix}${connector}${file} (too large, skipped)\n`;
      }
    }
  });

  return tree;
}

function generateDirectoryTreeLatex(dir, baseDir, maxFileSize, prefix = '') {
  let tree = '';
  const files = fs.readdirSync(dir);

  files.forEach((file, index) => {
    const fullPath = path.join(dir, file);

    if (shouldIgnore(fullPath, baseDir)) {
      return;
    }

    const isLast = index === files.length - 1;
    const connector = isLast ? '+-- ' : '|-- ';

    if (fs.statSync(fullPath).isDirectory()) {
      tree += `${prefix}${connector}${escapeLatex(file)}/\n`;
      tree += generateDirectoryTreeLatex(fullPath, baseDir, maxFileSize, prefix + (isLast ? '    ' : '|   '));
    } else {
      if (isBinaryFile(fullPath)) {
        tree += `${prefix}${connector}${escapeLatex(file)} (binary, skipped)\n`;
        return;
      }

      const stats = fs.statSync(fullPath);
      if (stats.size <= maxFileSize) {
        tree += `${prefix}${connector}${escapeLatex(file)}\n`;
      } else {
        tree += `${prefix}${connector}${escapeLatex(file)} (too large, skipped)\n`;
      }
    }
  });

  return tree;
}

function getAllFiles(dir, baseDir, maxFileSize) {
  const files = [];

  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);

    // Skip if ignored by gitignore
    if (shouldIgnore(fullPath, baseDir)) {
      return;
    }

    if (fs.statSync(fullPath).isDirectory()) {
      files.push(...getAllFiles(fullPath, baseDir, maxFileSize));
    } else {
      // Skip binary files
      if (isBinaryFile(fullPath)) {
        return;
      }

      const stats = fs.statSync(fullPath);
      if (stats.size <= maxFileSize) {
        files.push(fullPath);
      }
    }
  });

  return files;
}

// Get language for syntax highlighting
function getLanguage(extension) {
  const languageMap = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'cpp': 'cpp',
    'c': 'c',
    'go': 'go',
    'rs': 'rust',
    'php': 'php',
    'rb': 'ruby',
    'cs': 'csharp',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'html': 'html',
    'xml': 'xml',
    'md': 'markdown',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'sh': 'bash',
    'bash': 'bash',
    'sql': 'sql'
  };

  return languageMap[extension.toLowerCase()] || '';
}

function generateHTML(workDir, title, maxFileSize, filesSubset = null, partInfo = null) {
  let content = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
  content += `<style>${customStyle}</style>`;
  content += '</head><body>';
  content += `<h1>${title}${partInfo ? ` - Part ${partInfo.current}/${partInfo.total}` : ''}</h1>`;

  content += '<h2>Directory Structure</h2><div class="directory-tree">';
  content += generateDirectoryTree(workDir, workDir, maxFileSize);
  content += '</div>';

  content += '<h2>File Contents</h2>';
  const files = filesSubset || getAllFiles(workDir, workDir, maxFileSize);

  if (partInfo) {
    content += `<p>Showing files ${partInfo.startFile} to ${partInfo.endFile} of ${partInfo.totalFiles} total files</p>`;
  }

  files.forEach(file => {
    const code = fs.readFileSync(file, 'utf-8');
    const fileId = generateFileId(file);
    const extension = path.extname(file).slice(1);

    const language = getLanguage(extension);
    const highlightedCode = language ?
      hljs.highlight(code, { language }).value :
      hljs.highlightAuto(code).value;

    content += `<div class="file-container">`;
    content += `<h3 id="${fileId}">${file}</h3>`;
    content += `<pre><code class="hljs language-${language}">${highlightedCode}</code></pre>`;
    content += `</div>`;
  });

  content += '</body></html>';
  return content;
}

function generateLaTeX(workDir, title, maxFileSize) {
  // LaTeX document preamble
  let content = `\\documentclass[a4paper,11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage{geometry}
\\usepackage{hyperref}
\\usepackage{graphicx}
\\usepackage{fancyvrb}
\\usepackage{longtable}

\\geometry{margin=2cm}

% Define colors for syntax highlighting
\\definecolor{codebg}{RGB}{248,248,248}
\\definecolor{codestring}{RGB}{163,21,21}
\\definecolor{codecomment}{RGB}{0,128,0}
\\definecolor{codekeyword}{RGB}{0,0,255}
\\definecolor{codenumber}{RGB}{128,128,128}

% Listings style
\\lstset{
  backgroundcolor=\\color{codebg},
  basicstyle=\\ttfamily\\small,
  breakatwhitespace=false,
  breaklines=true,
  captionpos=b,
  commentstyle=\\color{codecomment},
  extendedchars=true,
  frame=single,
  keepspaces=true,
  keywordstyle=\\color{codekeyword}\\bfseries,
  numbers=left,
  numbersep=5pt,
  numberstyle=\\tiny\\color{codenumber},
  rulecolor=\\color{black},
  showspaces=false,
  showstringspaces=false,
  showtabs=false,
  stepnumber=1,
  stringstyle=\\color{codestring},
  tabsize=2,
  title=\\lstname
}

\\title{${escapeLatex(removeEmojis(title))}}
\\date{\\today}

\\begin{document}
\\maketitle
\\tableofcontents
\\newpage

`;

  // Directory structure section
  content += '\\section{Directory Structure}\n';
  content += '\\begin{verbatim}\n';
  content += generateDirectoryTreeLatex(workDir, workDir, maxFileSize);
  content += '\\end{verbatim}\n\n';

  // File contents section
  content += '\\section{File Contents}\n\n';
  const files = getAllFiles(workDir, workDir, maxFileSize);

  files.forEach(file => {
    let code = fs.readFileSync(file, 'utf-8');
    const extension = path.extname(file).slice(1).toLowerCase();
    const relativePath = path.relative(workDir, file);

    // Remove emojis from code
    code = removeEmojis(code);

    content += `\\subsection{${escapeLatex(relativePath)}}\n`;

    // Check if it's a markdown file - render as-is (converted to LaTeX)
    if (extension === 'md' || extension === 'markdown') {
      content += markdownToLatex(code);
      content += '\n\n';
    }
    // Check if it's an image file reference - include as-is (SVG not supported in LaTeX)
    else if (['png', 'jpg', 'jpeg', 'gif', 'pdf'].includes(extension)) {
      content += `\\begin{figure}[h]\n`;
      content += `\\centering\n`;
      content += `\\includegraphics[width=0.8\\textwidth]{${file}}\n`;
      content += `\\caption{${escapeLatex(relativePath)}}\n`;
      content += `\\end{figure}\n\n`;
    }
    // Regular code file - use listings
    else {
      const language = getListingsLanguage(extension);
      if (language) {
        content += `\\begin{lstlisting}[language=${language}]\n`;
      } else {
        content += `\\begin{lstlisting}\n`;
      }
      content += code;
      if (!code.endsWith('\n')) {
        content += '\n';
      }
      content += `\\end{lstlisting}\n\n`;
    }
  });

  content += '\\end{document}\n';
  return content;
}

async function generateLaTeXFile(inputPath, outputPath, maxFileSize) {
  const inputInfo = parseInput(inputPath);
  let workDir;
  let title;

  if (inputInfo.type === 'github') {
    workDir = await cloneRepo(inputInfo.repo);
    title = `GitHub: ${inputInfo.repo}`;
  } else {
    workDir = inputInfo.path;
    title = `Local Directory: ${path.basename(workDir)}`;
  }

  console.log(`Processing ${inputInfo.type === 'github' ? 'repository' : 'directory'}: ${workDir}`);

  const latex = generateLaTeX(workDir, title, maxFileSize);

  const texName = outputPath || (inputInfo.type === 'github' ?
    `${inputInfo.repo.replace('/', '-')}.tex` :
    `${path.basename(workDir)}.tex`);

  fs.writeFileSync(texName, latex);

  // Cleanup for GitHub repos
  if (inputInfo.type === 'github') {
    for (let i = 0; i < 3; i++) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i === 2) {
          console.warn('Warning: Could not delete temp directory, please delete manually:', workDir);
          break;
        }
        await sleep(1000);
      }
    }
  }

  console.log(`LaTeX file generated: ${texName}`);
}

async function generatePDF(inputPath, outputPath, maxFileSize, filesPerPdf) {
  const inputInfo = parseInput(inputPath);
  let workDir;
  let title;

  if (inputInfo.type === 'github') {
    workDir = await cloneRepo(inputInfo.repo);
    title = `GitHub: ${inputInfo.repo}`;
  } else {
    workDir = inputInfo.path;
    title = `Local Directory: ${path.basename(workDir)}`;
  }

  console.log(`Processing ${inputInfo.type === 'github' ? 'repository' : 'directory'}: ${workDir}`);

  // Get all files first
  const allFiles = getAllFiles(workDir, workDir, maxFileSize);
  const totalFiles = allFiles.length;

  console.log(`Found ${totalFiles} files`);

  // Calculate number of PDFs needed
  const numPdfs = Math.ceil(totalFiles / filesPerPdf);
  const shouldPaginate = numPdfs > 1;

  if (shouldPaginate) {
    console.log(`Large number of files, will split into ${numPdfs} PDF files`);
  }

  // Generate base PDF name
  const basePdfName = outputPath || (inputInfo.type === 'github' ?
    `${inputInfo.repo.replace('/', '-')}` :
    `${path.basename(workDir)}`);

  // Launch browser once for all PDFs
  const browser = await puppeteer.launch();

  try {
    for (let i = 0; i < numPdfs; i++) {
      const startIdx = i * filesPerPdf;
      const endIdx = Math.min((i + 1) * filesPerPdf, totalFiles);
      const filesChunk = allFiles.slice(startIdx, endIdx);

      const partInfo = shouldPaginate ? {
        current: i + 1,
        total: numPdfs,
        startFile: startIdx + 1,
        endFile: endIdx,
        totalFiles: totalFiles
      } : null;

      console.log(`Generating${shouldPaginate ? ` Part ${i + 1}/${numPdfs}` : ''} (${filesChunk.length} files)...`);

      const html = generateHTML(workDir, title, maxFileSize, filesChunk, partInfo);
      fs.writeFileSync('./code.html', html);

      const page = await browser.newPage();

      await page.setDefaultNavigationTimeout(1200000);
      await page.setDefaultTimeout(1200000);

      await page.goto(`file://${path.resolve('./code.html')}`, {
        waitUntil: 'networkidle0',
        timeout: 120000
      });

      // Generate PDF name with part number if paginated
      const pdfName = shouldPaginate ?
        `${basePdfName}-part${i + 1}.pdf` :
        `${basePdfName}.pdf`;

      await page.pdf({
        path: pdfName,
        format: 'A4',
        printBackground: true,
        margin: {
          top: '20mm',
          right: '20mm',
          bottom: '20mm',
          left: '20mm'
        },
        timeout: 120000
      });

      await page.close();
      console.log(`PDF generated: ${pdfName}`);

      await sleep(500);
      fs.unlinkSync('./code.html');
    }
  } finally {
    await browser.close();
  }

  if (inputInfo.type === 'github') {
    for (let i = 0; i < 3; i++) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i === 2) {
          console.warn('Warning: Could not delete temp directory, please delete manually:', workDir);
          break;
        }
        await sleep(1000);
      }
    }
  }

  if (shouldPaginate) {
    console.log(`All PDFs generated, total ${numPdfs} files`);
  }
}

// Main execution
const args = parseCLIArgs();

if (args.help) {
  showHelp();
  process.exit(0);
}

if (args.version) {
  showVersion();
  process.exit(0);
}

const maxFileSize = parseInt(args['max-size'], 10) * 1024; // Convert KB to bytes
const filesPerPdf = parseInt(args['files-per-pdf'], 10);
const format = args.format?.toLowerCase() || 'pdf';

if (format === 'latex' || format === 'tex') {
  generateLaTeXFile(args.input, args.output, maxFileSize).catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
} else if (format === 'pdf') {
  generatePDF(args.input, args.output, maxFileSize, filesPerPdf).catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
} else {
  console.error(`Unknown format: ${format}. Supported formats: pdf, latex`);
  process.exit(1);
}
