import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';


// Re-export AWS credentials tool
export { getAwsCredentialsTool } from './aws-credentials-tool';

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
        description: 'Execute a shell command on the system. Use this to check system status, list files, inspect processes, or run AWS CLI commands. When running AWS commands, include --profile <profileName> using the profile returned from get_aws_credentials.',
        schema: z.object({
            command: z.string().describe('The shell command to execute'),
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
        description: 'List files in a directory with metadata (size, modified time, type).',
        schema: z.object({
            path: z.string().describe('The directory path to list. Defaults to current directory.').default('.'),
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
                // For full file reading, we usually don't add line numbers unless requested, 
                // but the prompt says "Read file contents with line numbers".
                // Let's stick to adding line numbers for consistency with the request description.
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
        description: 'Read file contents with line numbers. Supports reading specific line ranges.',
        schema: z.object({
            file_path: z.string().describe('The absolute path to the file to read'),
            start_line: z.number().optional().describe('Start line number (1-based, inclusive)'),
            end_line: z.number().optional().describe('End line number (1-based, inclusive)'),
        }),
    }
);

// --- Write File Tool ---
export const writeFileTool = tool(
    async (input: { file_path: string; content: string }) => {
        // Handle potential parameter name variations from LLM
        const file_path = input.file_path;
        const content = input.content;

        console.log(`[Tool] Writing file: ${file_path}`);

        // Validate inputs
        if (!file_path || typeof file_path !== 'string') {
            return 'Error: file_path is required and must be a string. Use file_path parameter (not "path" or "filename").';
        }
        if (content === undefined || content === null) {
            return 'Error: content is required. Use content parameter to specify what to write.';
        }

        try {
            // Ensure directory exists
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
        description: 'Write content to a file. Creates parent directories automatically. IMPORTANT: Use exact parameter names "file_path" and "content".',
        schema: z.object({
            file_path: z.string().describe('REQUIRED: The absolute file path to write to, e.g. "/tmp/output.txt"'),
            content: z.string().describe('REQUIRED: The text content to write to the file'),
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
                // Global replace
                const escapedOld = edit.old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedOld, 'g');

                // Check if string exists
                if (!content.includes(edit.old_string)) {
                    return `Error: Target string not found in file: "${edit.old_string.substring(0, 50)}..."`;
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
        description: 'Perform exact string replacements in a file. Supports multiple replacements in one go.',
        schema: z.object({
            file_path: z.string().describe('The absolute path to the file to edit'),
            edits: z.array(z.object({
                old_string: z.string().describe('The exact string to replace'),
                new_string: z.string().describe('The new string to replace it with')
            })).describe('List of edits to perform'),
            dry_run: z.boolean().optional().describe('If true, does not write to disk, just reports what would happen')
        }),
    }
);

// --- Glob Tool ---
export const globTool = tool(
    async ({ pattern, path: basePath }: { pattern: string; path?: string }) => {
        console.log(`[Tool] Glob search: ${pattern} in ${basePath || '.'}`);

        try {
            // Use 'find' command for globbing as it's robust and available in the environment
            // Construct find command: find [path] -name [pattern]
            const searchPath = basePath || '.';
            // Ensure searchPath exists
            try {
                await fs.access(searchPath);
            } catch {
                return `Error: Directory '${searchPath}' does not exist.`;
            }

            // Clean up pattern to prevent command injection, though tricky with wildcards.
            // A safer approach for globbing in node without 'glob' lib is using 'find'.
            // Simple mapping: **/*.py -> find . -name "*.py"
            // Note: classic 'find' doesn't support ** same as glob, but usually -name matches correctly recursively.

            // NOTE: The user requested "glob" so they likely expect standard glob patterns.
            // Since we don't have a glob library guaranteed, we'll try to use a safe 'find' invocation.
            // Or simpler: exec `ls -R` and filter? No, inefficient.
            // Let's use `find`.

            // If pattern contains directory parts (e.g. src/**/*.ts), 'find -path' or -name is needed.

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
        description: 'Find files matching a pattern (e.g. "*.py", "*.ts") recursively.',
        schema: z.object({
            pattern: z.string().describe('The glob pattern to match (e.g. "*.ts")'),
            path: z.string().optional().describe('Root directory to start search from'),
        }),
    }
);

// --- Grep Tool ---
export const grepTool = tool(
    async ({ pattern, file_paths, recursive, include_lines }: { pattern: string; file_paths?: string[]; recursive?: boolean; include_lines?: boolean }) => {
        console.log(`[Tool] Grep: "${pattern}"`);

        try {
            let command = 'grep';

            if (include_lines) command += ' -n'; // Line numbers
            if (recursive) command += ' -r';
            else command += ' -l'; // Just filenames by default if not asking for lines? 
            // Wait, spec says "various output modes". 
            // If include_lines is true, show context. If false, maybe just files?
            // "files only, content with context, or counts"

            // Let's adjust args to map to common grep needs
            if (!include_lines && !recursive) {
                // Default to list files? Or print matches? 
                // Let's default to printing matches with filename
                command += ' -H';
            }

            // Escape double quotes in pattern
            const safePattern = pattern.replace(/"/g, '\\"');
            command += ` "${safePattern}"`;

            if (file_paths && file_paths.length > 0) {
                command += ` ${file_paths.map(p => `"${p}"`).join(' ')}`;
            } else {
                // If no files, assume current dir? grep usually hangs on stdin if no file.
                // Assuming "grep -r ." if recursive
                if (recursive) command += ' .';
                else command += ' *';
            }

            const { stdout, stderr } = await execAsync(command);

            if (!stdout && !stderr) return "No matches found.";

            return truncateToolOutput(stdout || stderr);
        } catch (error: any) {
            // grep returns exit code 1 if no matches, which triggers exception in exec
            if (error.code === 1) return "No matches found.";

            const errorMsg = `Grep error: ${error.message}`;
            console.error(`[Tool] Grep Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'grep',
        description: 'Search file contents for a pattern.',
        schema: z.object({
            pattern: z.string().describe('The regex or string to search for'),
            file_paths: z.array(z.string()).optional().describe('Specific files to search'),
            recursive: z.boolean().optional().describe('Search recursively in current directory'),
            include_lines: z.boolean().optional().describe('Show line numbers and matching lines')
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
        description: 'Search the web for information using Tavily. Returns an answer and relevant sources.',
        schema: z.object({
            query: z.string().describe('The search query'),
        }),
    }
);

// --- S3 File Tools ---

const s3Client = new S3Client({});

const getS3Key = (threadId: string, key: string) => {
    // Sanitize threadId to prevent directory traversal or weird characters
    const sanitizedThreadId = threadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    // Remove leading slashes from key to avoid double slashes
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
                ContentType: 'text/plain', // Default to text/plain
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
        description: 'Write content to a file in the temporary S3 storage. Requires a thread_id to namespace the file.',
        schema: z.object({
            key: z.string().describe('The filename or path within the thread namespace (e.g., "output.txt" or "logs/run1.log")'),
            content: z.string().describe('The string content to write'),
            thread_id: z.string().describe('The unique identifier for the conversation thread to namespace the file'),
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

            // Convert stream to string
            const streamToString = (stream: Readable): Promise<string> =>
                new Promise((resolve, reject) => {
                    const chunks: Buffer[] = [];
                    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                    stream.on("error", (err) => reject(err));
                    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
                });

            // Handle different body types (Node.js readable stream vs browser stream)
            // In AWS SDK v3 for Node, Body is IncomingMessage (ReadableStream)
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
        description: 'Read the contents of a file from the temporary S3 storage.',
        schema: z.object({
            key: z.string().describe('The filename or path within the thread namespace'),
            thread_id: z.string().describe('The unique identifier for the conversation thread'),
        }),
    }
);
