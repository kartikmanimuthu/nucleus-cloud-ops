import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

// Re-export AWS credentials tools
export { getAwsCredentialsTool, listAwsAccountsTool } from './aws-credentials-tool';

const execAsync = promisify(exec);

// Helper to truncate large tool outputs to prevent prompt token limits
const MAX_OUTPUT_LENGTH = 100000;
const truncateToolOutput = (output: string) => {
    if (output && output.length > MAX_OUTPUT_LENGTH) {
        return output.substring(0, MAX_OUTPUT_LENGTH) + `\n\n...[Output truncated due to length. Total length: ${output.length} characters]...`;
    }
    return output;
};

// Helper to format file size
const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// --- Execute Command Tool ---
export const executeCommandTool = tool(
    async ({ command }: { command: string }) => {
        console.log(`[Tool] Executing command: ${command}`);

        try {
            const { stdout, stderr } = await execAsync(command, {
                shell: '/bin/bash',
                timeout: 120000, // 2 minute timeout for long-running AWS CLI commands
                maxBuffer: 1024 * 1024 * 10, // 10MB buffer
            });

            const output = stdout || stderr || 'Command executed successfully (no output)';
            console.log(`[Tool] Command Output Length: ${output.length}`);

            return truncateToolOutput(output);
        } catch (error: any) {
            const errorMsg = `Command failed: ${error.message}\n${error.stderr || ''}`;
            console.error(`[Tool] Command Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'execute_command',
        description: 'Executes a non-interactive shell command on the local system. Use this to check system status, install dependencies, inspect processes, or run AWS CLI commands. WARNING: Commands must be non-interactive. When running AWS commands, always append --profile <profileName> using the profile returned from get_aws_credentials.',
        schema: z.object({
            command: z.string().describe('The bash shell command to execute. Chain commands with && if necessary. Do not use interactive commands like `nano` or `vim`.'),
        }),
    }
);

// --- LS Tool ---
export const lsTool = tool(
    async ({ path: dirPath }: { path: string }) => {
        console.log(`[Tool] Listing contents: ${dirPath}`);
        try {
            const fullPath = path.resolve(dirPath);
            const stats = await fs.stat(fullPath);

            if (!stats.isDirectory()) {
                return `Error: ${dirPath} is not a directory`;
            }

            const items = await fs.readdir(fullPath, { withFileTypes: true });
            const itemDetails = await Promise.all(items.map(async (item) => {
                const itemPath = path.join(fullPath, item.name);
                try {
                    const itemStats = await fs.stat(itemPath);
                    const type = item.isDirectory() ? 'DIR' : 'FILE';
                    const size = item.isDirectory() ? '-' : formatSize(itemStats.size);
                    const modTime = itemStats.mtime.toISOString().split('T')[0]; // YYYY-MM-DD
                    return { name: item.name, type, size, modTime };
                } catch (e) {
                    return null;
                }
            }));

            // Filter nulls and format output
            const validItems = itemDetails.filter(i => i !== null) as any[];

            // Header
            let output = `Directory: ${dirPath}\n`;
            output += `Type\tSize\tModified\tName\n`;
            output += `----\t----\t--------\t----\n`;

            for (const item of validItems) {
                output += `${item.type}\t${item.size}\t${item.modTime}\t${item.name}\n`;
            }

            output += `\nTotal items: ${validItems.length}`;
            return truncateToolOutput(output);
        } catch (error: any) {
            const errorMsg = `Error listing directory: ${error.message}`;
            console.error(`[Tool] LS Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'ls',
        description: 'Lists the contents of a directory, returning metadata like size, modified time, and type (DIR/FILE). Use this to explore folder structures before attempting to read or edit files.',
        schema: z.object({
            path: z.string().describe('The absolute or relative directory path to list. Defaults to the current working directory (".").').default('.'),
        }),
    }
);

// --- Read File Tool ---
export const readFileTool = tool(
    async ({ file_path, start_line, end_line }: { file_path: string; start_line?: number; end_line?: number }) => {
        console.log(`[Tool] Reading file: ${file_path}`);

        try {
            const content = await fs.readFile(file_path, 'utf-8');
            const lines = content.split('\n');

            let result = content;
            let rangeInfo = '';

            // Handle line range if specified
            if (start_line !== undefined || end_line !== undefined) {
                const start = (start_line && start_line > 0) ? start_line - 1 : 0;
                const end = (end_line && end_line <= lines.length) ? end_line : lines.length;

                if (start >= lines.length) {
                    return `Error: Start line ${start_line} is beyond file length (${lines.length} lines).`;
                }

                const selectedLines = lines.slice(start, end);

                // Add line numbers
                result = selectedLines.map((line, index) => `${start + index + 1}: ${line}`).join('\n');
                rangeInfo = ` (Lines ${start + 1}-${end})`;
            } else {
                result = lines.map((line, index) => `${index + 1}: ${line}`).join('\n');
            }

            console.log(`[Tool] File read successfully${rangeInfo}, length: ${result.length}`);
            return truncateToolOutput(result);
        } catch (error: any) {
            const errorMsg = `Error reading file: ${error.message}`;
            console.error(`[Tool] Read Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'read_file',
        description: 'Reads the contents of a file and prefixes each line with its line number. For large files, strongly prefer using start_line and end_line to paginate the output and avoid hitting token limits.',
        schema: z.object({
            file_path: z.string().describe('The absolute or relative path to the file you want to read.'),
            start_line: z.number().optional().describe('The starting line number to read (1-based, inclusive). Use to read files in chunks.'),
            end_line: z.number().optional().describe('The ending line number to read (1-based, inclusive).'),
        }),
    }
);

// --- Write File Tool ---
export const writeFileTool = tool(
    async (input: { file_path: string; content: string }) => {
        const file_path = input.file_path;
        const content = input.content;

        console.log(`[Tool] Writing file: ${file_path}`);

        if (!file_path || typeof file_path !== 'string') {
            return 'Error: file_path is required and must be a string. Use file_path parameter (not "path" or "filename").';
        }
        if (content === undefined || content === null) {
            return 'Error: content is required. Use content parameter to specify what to write.';
        }

        try {
            const dir = path.dirname(file_path);
            if (dir && dir !== '.') {
                await fs.mkdir(dir, { recursive: true });
            }

            await fs.writeFile(file_path, content, 'utf-8');
            console.log(`[Tool] File written successfully`);
            return `Successfully written to '${file_path}'.`;
        } catch (error: any) {
            const errorMsg = `Error writing file: ${error.message}`;
            console.error(`[Tool] Write Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'write_file',
        description: 'Creates a new file or completely overwrites an existing file with new content. Automatically creates parent directories if they do not exist. If you only need to modify part of an existing file, use `edit_file` instead.',
        schema: z.object({
            file_path: z.string().describe('REQUIRED: The absolute or relative file path to write to (e.g. "/tmp/output.txt"). You must use the exact parameter name "file_path".'),
            content: z.string().describe('REQUIRED: The full text content to write into the file. Do not truncate this.'),
        }),
    }
);

// --- Edit File Tool ---
export const editFileTool = tool(
    async ({ file_path, edits, dry_run }: { file_path: string; edits: Array<{ old_string: string, new_string: string }>; dry_run?: boolean }) => {
        console.log(`[Tool] Editing file: ${file_path} with ${edits.length} edits`);

        try {
            let content = await fs.readFile(file_path, 'utf-8');
            let updatedContent = content;

            for (const edit of edits) {
                const escapedOld = edit.old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedOld, 'g');

                if (!content.includes(edit.old_string)) {
                    return `Error: Target string not found in file: "${edit.old_string.substring(0, 50)}..." Make sure you are matching whitespace and indentation exactly.`;
                }

                updatedContent = updatedContent.replace(regex, edit.new_string);
            }

            if (content === updatedContent) {
                return "No changes made (content matched existing state).";
            }

            if (!dry_run) {
                await fs.writeFile(file_path, updatedContent, 'utf-8');
                console.log(`[Tool] File updated successfully`);
                return `Successfully applied ${edits.length} edit(s) to ${file_path}.`;
            } else {
                return `[DRY RUN] Would apply ${edits.length} edit(s). New size: ${updatedContent.length} bytes.`;
            }
        } catch (error: any) {
            const errorMsg = `Error editing file: ${error.message}`;
            console.error(`[Tool] Edit Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'edit_file',
        description: 'Applies targeted search-and-replace string edits to a specific file. This is highly preferred over write_file for modifying existing code. You must match the `old_string` EXACTLY as it appears in the file, including all whitespace, tabs, and indentation.',
        schema: z.object({
            file_path: z.string().describe('The absolute or relative path to the file being edited.'),
            edits: z.array(z.object({
                old_string: z.string().describe('The exact string to be replaced. Must be an exact substring match (no regex needed, it escapes automatically). Include enough context (like surrounding lines or indentation) to ensure you are replacing the correct instance.'),
                new_string: z.string().describe('The new string to insert in place of old_string.')
            })).describe('An array of exact string replacements to perform sequentially.'),
            dry_run: z.boolean().optional().describe('Set to true to test if your old_string matches without actually writing to disk.')
        }),
    }
);

// --- Glob Tool ---
export const globTool = tool(
    async ({ pattern, path: basePath }: { pattern: string; path?: string }) => {
        console.log(`[Tool] Glob search: ${pattern} in ${basePath || '.'}`);

        try {
            const searchPath = basePath || '.';
            try {
                await fs.access(searchPath);
            } catch {
                return `Error: Directory '${searchPath}' does not exist.`;
            }

            const command = `find "${searchPath}" -name "${pattern}" -not -path '*/node_modules/*' -maxdepth 10`;

            const { stdout, stderr } = await execAsync(command);

            if (stderr) {
                console.warn(`[Tool] Glob stderr: ${stderr}`);
            }

            const files = stdout.split('\n').filter(Boolean).map(f => f.trim());

            if (files.length === 0) {
                return "No matching files found.";
            }

            if (files.length > 100) {
                return truncateToolOutput(`Found ${files.length} files. First 100:\n${files.slice(0, 100).join('\n')}\n...(and ${files.length - 100} more)`);
            }

            return truncateToolOutput(files.join('\n'));
        } catch (error: any) {
            const errorMsg = `Glob error: ${error.message}`;
            console.error(`[Tool] Glob Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'glob',
        description: 'Finds files matching a specific naming pattern recursively. Useful for locating files across a large project (e.g., finding all tests, or a specific component file). Excludes node_modules by default.',
        schema: z.object({
            pattern: z.string().describe('The filename pattern to match (e.g., "*.ts", "App.tsx", "*test*"). Do not include path slashes in the pattern.'),
            path: z.string().optional().describe('The root directory to start the recursive search from. Defaults to the current directory (".").'),
        }),
    }
);

// --- Grep Tool ---
export const grepTool = tool(
    async ({ pattern, file_paths, recursive, include_lines }: { pattern: string; file_paths?: string[]; recursive?: boolean; include_lines?: boolean }) => {
        console.log(`[Tool] Grep: "${pattern}"`);

        try {
            let command = 'grep';

            if (include_lines) command += ' -n';
            if (recursive) command += ' -r';
            else command += ' -l';

            if (!include_lines && !recursive) {
                command += ' -H';
            }

            const safePattern = pattern.replace(/"/g, '\\"');
            command += ` "${safePattern}"`;

            if (file_paths && file_paths.length > 0) {
                command += ` ${file_paths.map(p => `"${p}"`).join(' ')}`;
            } else {
                if (recursive) command += ' .';
                else command += ' *';
            }

            const { stdout, stderr } = await execAsync(command);

            if (!stdout && !stderr) return "No matches found.";

            return truncateToolOutput(stdout || stderr);
        } catch (error: any) {
            if (error.code === 1) return "No matches found.";

            const errorMsg = `Grep error: ${error.message}`;
            console.error(`[Tool] Grep Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'grep',
        description: 'Searches for a regex or string pattern inside file contents. Highly recommended for finding function definitions, variable usages, or specific code snippets within a codebase without reading whole files.',
        schema: z.object({
            pattern: z.string().describe('The regex or string to search for (e.g., "function handleSubmit" or "import.*react").'),
            file_paths: z.array(z.string()).optional().describe('An array of specific file paths to restrict the search to.'),
            recursive: z.boolean().optional().describe('Set to true to search through all files in the current directory recursively.'),
            include_lines: z.boolean().optional().describe('Set to true to print the actual matched text and line numbers. If false, it only returns the filenames that contain the match.')
        }),
    }
);

// --- Web Search Tool (Tavily) ---
export const webSearchTool = tool(
    async ({ query }: { query: string }) => {
        console.log(`[Tool] Web search: ${query}`);

        const apiKey = process.env.TAVILY_API_KEY;
        if (!apiKey) {
            return 'Error: TAVILY_API_KEY not configured in environment variables.';
        }

        try {
            const response = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    api_key: apiKey,
                    query,
                    max_results: 5,
                    include_answer: true,
                    include_raw_content: false,
                }),
            });

            if (!response.ok) {
                throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            let result = '';
            if (data.answer) {
                result += `**Answer:** ${data.answer}\n\n`;
            }

            if (data.results && data.results.length > 0) {
                result += '**Sources:**\n';
                for (const r of data.results.slice(0, 3)) {
                    result += `- [${r.title}](${r.url})\n  ${r.content?.slice(0, 200)}...\n\n`;
                }
            }

            console.log(`[Tool] Search completed, found ${data.results?.length || 0} results`);
            return truncateToolOutput(result || 'No results found.');
        } catch (error: any) {
            const errorMsg = `Web search error: ${error.message}`;
            console.error(`[Tool] Search Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'web_search',
        description: 'Performs a real-time web search. Use this when you need up-to-date documentation, recent news, or factual data outside your core knowledge base. Returns an answer and relevant source links.',
        schema: z.object({
            query: z.string().describe('The targeted search query string. Optimize for search engines (e.g., "React 19 server components docs").'),
        }),
    }
);

// --- S3 File Tools ---

const s3Client = new S3Client({});

const getS3Key = (threadId: string, key: string) => {
    const sanitizedThreadId = threadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sanitizedKey = key.replace(/^\/+/, '');
    return `${sanitizedThreadId}/${sanitizedKey}`;
};

export const writeFileToS3Tool = tool(
    async ({ key, content, thread_id }: { key: string; content: string; thread_id: string }) => {
        const bucketName = process.env.AGENT_TEMP_BUCKET;
        if (!bucketName) {
            return 'Error: AGENT_TEMP_BUCKET environment variable is not set.';
        }

        const s3Key = getS3Key(thread_id, key);
        console.log(`[Tool] Writing file to S3: s3://${bucketName}/${s3Key}`);

        try {
            await s3Client.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: s3Key,
                Body: content,
                ContentType: 'text/plain',
            }));
            const msg = `Successfully written to s3://${bucketName}/${s3Key}`;
            console.log(`[Tool] ${msg}`);
            return msg;
        } catch (error: any) {
            const errorMsg = `Error writing file to S3: ${error.message}`;
            console.error(`[Tool] S3 Write Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'write_file_to_s3',
        description: 'Writes or overwrites text content to a temporary S3 cloud storage bucket. Use to persist data, logs, or config files across the current conversation.',
        schema: z.object({
            key: z.string().describe('The destination filename or relative path (e.g., "script.js"). Do not use leading slashes.'),
            content: z.string().describe('The raw string content to be written to the file.'),
            thread_id: z.string().describe('The unique identifier for the current conversation thread to namespace the file correctly.'),
        }),
    }
);

export const getFileFromS3Tool = tool(
    async ({ key, thread_id }: { key: string; thread_id: string }) => {
        const bucketName = process.env.AGENT_TEMP_BUCKET;
        if (!bucketName) {
            return 'Error: AGENT_TEMP_BUCKET environment variable is not set.';
        }

        const s3Key = getS3Key(thread_id, key);
        console.log(`[Tool] Reading file from S3: s3://${bucketName}/${s3Key}`);

        try {
            const response = await s3Client.send(new GetObjectCommand({
                Bucket: bucketName,
                Key: s3Key,
            }));

            if (!response.Body) {
                return 'Error: Empty response body from S3.';
            }

            const streamToString = (stream: Readable): Promise<string> =>
                new Promise((resolve, reject) => {
                    const chunks: Buffer[] = [];
                    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                    stream.on("error", (err) => reject(err));
                    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
                });

            const content = await streamToString(response.Body as Readable);

            console.log(`[Tool] S3 file read successfully, length: ${content.length}`);
            return truncateToolOutput(content);
        } catch (error: any) {
            const errorMsg = `Error reading file from S3: ${error.message}`;
            console.error(`[Tool] S3 Read Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'get_file_from_s3',
        description: 'Retrieves the text content of a file previously saved in the temporary S3 cloud storage bucket.',
        schema: z.object({
            key: z.string().describe('The exact filename or relative path of the file to retrieve (e.g., "script.js").'),
            thread_id: z.string().describe('The unique identifier for the current conversation thread.'),
        }),
    }
);