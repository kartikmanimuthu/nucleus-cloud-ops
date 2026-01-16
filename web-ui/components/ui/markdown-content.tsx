"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * MarkdownContent component for rendering markdown text with proper formatting.
 * Supports GitHub-flavored markdown including tables, strikethrough, and task lists.
 */
export function MarkdownContent({ content, className }: MarkdownContentProps) {
  if (!content) return null;

  return (
    <div className={cn("markdown-content", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Headings
          h1: ({ children }) => (
            <h1 className="text-xl font-bold mt-4 mb-2 first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-bold mt-3 mb-2 first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-semibold mt-2 mb-1 first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h4>
          ),
          
          // Paragraphs
          p: ({ children }) => (
            <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
          ),
          
          // Bold and italic
          strong: ({ children }) => (
            <strong className="font-bold">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic">{children}</em>
          ),
          
          // Links
          a: ({ href, children }) => (
            <a 
              href={href} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-primary underline hover:text-primary/80 transition-colors"
            >
              {children}
            </a>
          ),
          
          // Lists
          ul: ({ children }) => (
            <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed">{children}</li>
          ),
          
          // Code
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code 
                  className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-foreground"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={cn("block", className)} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="bg-muted/50 border rounded-md p-3 mb-2 overflow-x-auto text-xs font-mono">
              {children}
            </pre>
          ),
          
          // Blockquotes
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-primary/50 pl-4 py-1 mb-2 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          
          // Tables
          table: ({ children }) => (
            <div className="overflow-x-auto mb-2">
              <table className="min-w-full border-collapse text-xs">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-muted/50">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="border border-border px-2 py-1 font-semibold text-left">
              {children}
            </th>
          ),
          tbody: ({ children }) => (
            <tbody>{children}</tbody>
          ),
          tr: ({ children }) => (
            <tr className="border-b border-border">{children}</tr>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1">{children}</td>
          ),
          
          // Horizontal rule
          hr: () => (
            <hr className="border-t border-border my-4" />
          ),
          
          // Images
          img: ({ src, alt }) => (
            <img 
              src={src} 
              alt={alt || ""} 
              className="max-w-full h-auto rounded-md my-2"
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
