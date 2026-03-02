"use client";

import { useRef, useState } from "react";
import { X, Paperclip, FileImage } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FileAttachment {
  name: string;
  type: string;
  size: number;
  data: string; // base64
  preview?: string;
}

interface FileUploadProps {
  onFilesChange: (files: FileAttachment[]) => void;
  files: FileAttachment[];
  disabled?: boolean;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export function FileUpload({ onFilesChange, files, disabled }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>("");

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    setError("");

    const validFiles: FileAttachment[] = [];

    for (const file of selectedFiles) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        setError(`${file.name}: Only images are supported`);
        continue;
      }

      if (file.size > MAX_FILE_SIZE) {
        setError(`${file.name}: File too large (max 5MB)`);
        continue;
      }

      const base64 = await fileToBase64(file);
      validFiles.push({
        name: file.name,
        type: file.type,
        size: file.size,
        data: base64,
        preview: URL.createObjectURL(file),
      });
    }

    onFilesChange([...files, ...validFiles]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const removeFile = (index: number) => {
    const newFiles = files.filter((_, i) => i !== index);
    onFilesChange(newFiles);
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ALLOWED_TYPES.join(",")}
        onChange={handleFileSelect}
        className="hidden"
        disabled={disabled}
      />

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 p-2 bg-muted/30 rounded-md">
          {files.map((file, idx) => (
            <div
              key={idx}
              className="relative group rounded-md overflow-hidden border bg-background"
            >
              {file.preview ? (
                <img
                  src={file.preview}
                  alt={file.name}
                  className="h-16 w-16 object-cover"
                />
              ) : (
                <div className="h-16 w-16 flex items-center justify-center bg-muted">
                  <FileImage className="h-6 w-6 text-muted-foreground" />
                </div>
              )}
              <button
                onClick={() => removeFile(idx)}
                className="absolute top-0.5 right-0.5 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="h-7 text-xs"
      >
        <Paperclip className="h-3.5 w-3.5 mr-1" />
        Attach Images
      </Button>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]); // Remove data:image/...;base64, prefix
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
