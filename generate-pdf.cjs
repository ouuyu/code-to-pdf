const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const hljs = require('highlight.js');
const { execSync } = require('child_process');

const input = process.argv[2] || './src';
const MAX_FILE_SIZE = 100 * 1024; // 100KB

const fileIdMap = new Map();

const customStyle = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf-8');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function generateDirectoryTree(dir, prefix = '') {
  let tree = '';
  const files = fs.readdirSync(dir);
  
  files.forEach((file, index) => {
    const fullPath = path.join(dir, file);
    const isLast = index === files.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    
    if (!['.git', 'node_modules', 'dist', '.vscode'].includes(file)) {
      if (fs.statSync(fullPath).isDirectory()) {
        tree += `${prefix}${connector}${file}/\n`;
        tree += generateDirectoryTree(fullPath, prefix + (isLast ? '    ' : '│   '));
      } else {
        const stats = fs.statSync(fullPath);
        if (stats.size <= MAX_FILE_SIZE) {
          const fileId = generateFileId(fullPath);
          tree += `${prefix}${connector}<a href="#${fileId}">${file}</a>\n`;
        } else {
          tree += `${prefix}${connector}${file} (文件过大，已跳过)\n`;
        }
      }
    }
  });
  
  return tree;
}

function getAllFiles(dir) {
  const files = [];
  
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (!['.git', 'node_modules', 'dist', '.vscode'].includes(file)) {
        files.push(...getAllFiles(fullPath));
      }
    } else {
      const stats = fs.statSync(fullPath);
      if (stats.size <= MAX_FILE_SIZE) {
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

function generateHTML(workDir, title) {
  let content = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
  content += `<style>${customStyle}</style>`;
  content += '</head><body>';
  content += `<h1>${title}</h1>`;
  
  content += '<h2>目录结构</h2><div class="directory-tree">';
  content += generateDirectoryTree(workDir);
  content += '</div>';
  
  content += '<h2>文件内容</h2>';
  const files = getAllFiles(workDir);
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

async function generatePDF() {
  const inputInfo = parseInput(input);
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

  const html = generateHTML(workDir, title);
  fs.writeFileSync('./code.html', html);

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  await page.setDefaultNavigationTimeout(1200000);
  await page.setDefaultTimeout(1200000);
  
  await page.goto(`file://${path.resolve('./code.html')}`, {
    waitUntil: 'networkidle0',
    timeout: 120000
  });
  
  const pdfName = inputInfo.type === 'github' ? 
    `${inputInfo.repo.replace('/', '-')}.pdf` : 
    `${path.basename(workDir)}.pdf`;
  
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

generatePDF().catch(error => {
  console.error('发生错误:', error);
  process.exit(1);
});