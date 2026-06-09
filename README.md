# code-to-pdf

Convert code repositories and directories to beautifully formatted PDFs with syntax highlighting.

## Features

- **Syntax Highlighting** - Automatic syntax highlighting for 20+ programming languages
- **Directory Tree** - Interactive table of contents with clickable file links
- **Smart Filtering** - Respects `.gitignore` files (including nested ones) and skips binary files automatically
- **PDF Pagination** - Automatically splits large repositories into multiple PDFs for reliable export
- **GitHub Support** - Clone and convert GitHub repositories directly
- **Configurable** - Customize output path, file size limits, and pagination settings

## Installation

```bash
# Clone the repository
git clone https://github.com/ouuyu/code-to-pdf.git
cd code-to-pdf

# Install dependencies
pnpm install
# or
npm install

# Install Puppeteer Chrome (if not already installed)
npx puppeteer browsers install chrome
```

## Usage

### Basic Usage

```bash
# Convert current directory
node generate-pdf.cjs .

# Convert a specific directory
node generate-pdf.cjs ./src

# Convert with custom output name
node generate-pdf.cjs ./src -o my-code.pdf
```

### GitHub Repository

```bash
# Using owner/repo format
node generate-pdf.cjs facebook/react

# Using full URL
node generate-pdf.cjs https://github.com/facebook/react

# With custom file size limit (200KB)
node generate-pdf.cjs facebook/react --max-size 200

# With pagination (100 files per PDF)
node generate-pdf.cjs facebook/react --files-per-pdf 100
```

### Command Line Options

```
Usage:
  node generate-pdf.cjs [options] [input]

Arguments:
  input                      Path to local directory or GitHub repository

Options:
  -i, --input <path>         Input path (default: ./src)
  -o, --output <path>        Output PDF file path (auto-generated if not specified)
  -s, --max-size <kb>        Maximum file size in KB to include (default: 100)
  -f, --files-per-pdf <n>    Maximum files per PDF for pagination (default: 50)
  -h, --help                 Show this help message
  -v, --version              Show version information
```

### Examples

```bash
# Show help
node generate-pdf.cjs --help

# Show version
node generate-pdf.cjs --version

# Convert with all options
node generate-pdf.cjs -i ./my-project -o output.pdf -s 150 -f 100

# Short form options
node generate-pdf.cjs -i ./src -o docs.pdf

# Convert GitHub repo with size limit
node generate-pdf.cjs microsoft/vscode --max-size 200

# Large repository with pagination
node generate-pdf.cjs torvalds/linux --files-per-pdf 50
```

## How It Works

1. **Scans** the directory or clones the GitHub repository
2. **Filters** files using `.gitignore` rules (including nested `.gitignore` files) and skips binary files
3. **Generates** HTML documents with:
   - Interactive directory tree
   - Syntax-highlighted code for each file
4. **Converts** HTML to PDF using Puppeteer
5. **Paginates** large repositories into multiple PDFs for reliability

## File Filtering

The tool automatically skips:

- Files and directories in `.gitignore` (respects nested `.gitignore` files)
- Binary files (images, executables, etc.)
- Files larger than the size limit (default: 100KB)
- Default system directories: `.git`, `node_modules`, `dist`, `.vscode`
- `.gitignore` files themselves

## PDF Pagination

For large repositories, the tool automatically splits output into multiple PDFs:

- Default: 50 files per PDF
- Customize with `--files-per-pdf` option
- Output files named: `output-part1.pdf`, `output-part2.pdf`, etc.
- Each part includes the full directory tree for reference

## Supported Languages

JavaScript, TypeScript, Python, Java, C++, C, Go, Rust, PHP, Ruby, C#, CSS, SCSS, LESS, HTML, XML, Markdown, JSON, YAML, Bash, SQL, and more...

## Requirements

- Node.js 18.11.0 or higher (for native `parseArgs` support)
- Chrome/Chromium (installed automatically by Puppeteer)

## License

MIT
