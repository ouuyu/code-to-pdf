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
  -i, --input <path>      Input path (default: ./src)
  -o, --output <path>     Output PDF file path (auto-generated if not specified)
  -s, --max-size <kb>     Maximum file size in KB to include (default: 100)
  -h, --help              Show this help message
  -v, --version           Show version information

Examples:
  node generate-pdf.cjs ./src
  node generate-pdf.cjs -i ./src -o output.pdf
  node generate-pdf.cjs owner/repo
  node generate-pdf.cjs https://github.com/owner/repo -s 200
  node generate-pdf.cjs -i owner/repo --max-size 150

Features:
  - Respects .gitignore files
  - Automatically skips binary files
  - Syntax highlighting for multiple languages
  - Generates clickable table of contents
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

// Parse .gitignore files and create an ignore instance
function createIgnoreInstance(baseDir) {
  const ig = ignore();
  
  // Add default ignores
  ig.add(['.git', 'node_modules', 'dist', '.vscode', 'Cargo.lock', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml']);
  
  // Read .gitignore file if it exists
  const gitignorePath = path.join(baseDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    ig.add(gitignoreContent);
  }
  
  return ig;
}

// Check if a file path should be ignored based on gitignore rules
function shouldIgnore(filePath, baseDir, ig) {
  const relativePath = path.relative(baseDir, filePath);
  return ig.ignores(relativePath);
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
  console.log(`正在克隆仓库: ${repo}...`);
  
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
    console.error('克隆仓库失败:', error.message);
    process.exit(1);
  }
}

function generateDirectoryTree(dir, baseDir, ig, maxFileSize, prefix = '') {
  let tree = '';
  const files = fs.readdirSync(dir);
  
  files.forEach((file, index) => {
    const fullPath = path.join(dir, file);
    
    // Skip if ignored by gitignore or binary
    if (shouldIgnore(fullPath, baseDir, ig)) {
      return;
    }
    
    const isLast = index === files.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    
    if (fs.statSync(fullPath).isDirectory()) {
      tree += `${prefix}${connector}${file}/\n`;
      tree += generateDirectoryTree(fullPath, baseDir, ig, maxFileSize, prefix + (isLast ? '    ' : '│   '));
    } else {
      // Skip binary files
      if (isBinaryFile(fullPath)) {
        tree += `${prefix}${connector}${file} (二进制文件，已跳过)\n`;
        return;
      }
      
      const stats = fs.statSync(fullPath);
      if (stats.size <= maxFileSize) {
        const fileId = generateFileId(fullPath);
        tree += `${prefix}${connector}<a href="#${fileId}">${file}</a>\n`;
      } else {
        tree += `${prefix}${connector}${file} (文件过大，已跳过)\n`;
      }
    }
  });
  
  return tree;
}

function getAllFiles(dir, baseDir, ig, maxFileSize) {
  const files = [];
  
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    
    // Skip if ignored by gitignore
    if (shouldIgnore(fullPath, baseDir, ig)) {
      return;
    }
    
    if (fs.statSync(fullPath).isDirectory()) {
      files.push(...getAllFiles(fullPath, baseDir, ig, maxFileSize));
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

// 获取文件对应的语言
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

function generateHTML(workDir, title, maxFileSize) {
  // Create ignore instance for this directory
  const ig = createIgnoreInstance(workDir);
  
  let content = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
  content += `<style>${customStyle}</style>`;
  content += '</head><body>';
  content += `<h1>${title}</h1>`;
  
  content += '<h2>目录结构</h2><div class="directory-tree">';
  content += generateDirectoryTree(workDir, workDir, ig, maxFileSize);
  content += '</div>';
  
  content += '<h2>文件内容</h2>';
  const files = getAllFiles(workDir, workDir, ig, maxFileSize);
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

async function generatePDF(inputPath, outputPath, maxFileSize) {
  const inputInfo = parseInput(inputPath);
  let workDir;
  let title;

  if (inputInfo.type === 'github') {
    workDir = await cloneRepo(inputInfo.repo);
    title = `GitHub: ${inputInfo.repo}`;
  } else {
    workDir = inputInfo.path;
    title = `本地目录: ${path.basename(workDir)}`;
  }

  console.log(`正在处理${inputInfo.type === 'github' ? '仓库' : '目录'}: ${workDir}`);

  const html = generateHTML(workDir, title, maxFileSize);
  fs.writeFileSync('./code.html', html);

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  await page.setDefaultNavigationTimeout(1200000);
  await page.setDefaultTimeout(1200000);
  
  await page.goto(`file://${path.resolve('./code.html')}`, {
    waitUntil: 'networkidle0',
    timeout: 120000
  });
  
  // Use custom output path if provided, otherwise auto-generate
  const pdfName = outputPath || (inputInfo.type === 'github' ? 
    `${inputInfo.repo.replace('/', '-')}.pdf` : 
    `${path.basename(workDir)}.pdf`);
  
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

  await browser.close();
  
  await sleep(1000);
  
  fs.unlinkSync('./code.html');
  if (inputInfo.type === 'github') {
    for (let i = 0; i < 3; i++) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i === 2) {
          console.warn('警告: 无法删除临时目录，请手动删除:', workDir);
          break;
        }
        await sleep(1000);
      }
    }
  }
  
  console.log(`PDF 生成成功: ${pdfName}`);
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

generatePDF(args.input, args.output, maxFileSize).catch(error => {
  console.error('发生错误:', error);
  process.exit(1);
});