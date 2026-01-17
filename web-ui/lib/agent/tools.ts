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

// --- Execute Command Tool ---
export const executeCommandTool = tool(
    async ({ command }: { command: string }) => {
        console.log(`[Tool] Executing command: ${command}`);

        try {
            const { stdout, stderr } = await execAsync(command, {
                timeout: 30000, // 30 second timeout
                maxBuffer: 1024 * 1024 * 10, // 10MB buffer
            });

            const output = stdout || stderr || 'Command executed successfully (no output)';
            console.log(`[Tool] Command Output Length: ${output.length}`);

            return output;
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

// --- Read File Tool ---
export const readFileTool = tool(
    async ({ file_path }: { file_path: string }) => {
        console.log(`[Tool] Reading file: ${file_path}`);

        try {
            const content = await fs.readFile(file_path, 'utf-8');
            console.log(`[Tool] File read successfully, length: ${content.length}`);
            return content;
        } catch (error: any) {
            const errorMsg = `Error reading file: ${error.message}`;
            console.error(`[Tool] Read Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'read_file',
        description: 'Read the contents of a file at the given path.',
        schema: z.object({
            file_path: z.string().describe('The absolute path to the file to read'),
        }),
    }
);

// --- Write File Tool ---
export const writeFileTool = tool(
    async ({ file_path, content }: { file_path: string; content: string }) => {
        console.log(`[Tool] Writing file: ${file_path}`);

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
        description: 'Write content to a file at the given path. Creates the file and parent directories if they do not exist. Overwrites existing content.',
        schema: z.object({
            file_path: z.string().describe('The absolute path to the file to write'),
            content: z.string().describe('The content to write to the file'),
        }),
    }
);

// --- List Directory Tool ---
export const listDirectoryTool = tool(
    async ({ path: dirPath }: { path: string }) => {
        console.log(`[Tool] Listing directory: ${dirPath}`);

        try {
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            const listing = items.map(item => {
                const type = item.isDirectory() ? '[DIR]' : '[FILE]';
                return `${type} ${item.name}`;
            }).join('\n');

            console.log(`[Tool] Directory listed, ${items.length} items`);
            return listing || '(Empty directory)';
        } catch (error: any) {
            const errorMsg = `Error listing directory: ${error.message}`;
            console.error(`[Tool] List Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'list_directory',
        description: 'List the contents of a directory at the given path.',
        schema: z.object({
            path: z.string().describe('The path to the directory to list').default('.'),
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
            return result || 'No results found.';
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
            return content;
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
