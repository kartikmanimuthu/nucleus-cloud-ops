"use client"

import type React from "react"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Upload, FileText, AlertTriangle, CheckCircle } from "lucide-react"
import { ClientAccountService } from "@/lib/client-account-service"

interface ImportAccountsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ImportAccountsDialog({ open, onOpenChange }: ImportAccountsDialogProps) {
  const [importMethod, setImportMethod] = useState<"file" | "json">("file")
  const [jsonData, setJsonData] = useState("")
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    accounts: number
    errors: string[]
  } | null>(null)

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      setSelectedFile(file)

      // Validate file content
      const reader = new FileReader()
      reader.onload = (e) => {
        try {
          const content = e.target?.result as string
          const parsed = JSON.parse(content)

          if (parsed.accounts && Array.isArray(parsed.accounts)) {
            const validAccounts = parsed.accounts.filter((acc: any) =>
              acc.name && acc.accountId && acc.roleArn
            )

            setValidationResult({
              valid: validAccounts.length > 0,
              accounts: validAccounts.length,
              errors: parsed.accounts.length !== validAccounts.length
                ? ['Some accounts have missing required fields (name, accountId, roleArn)']
                : [],
            })
          } else {
            setValidationResult({
              valid: false,
              accounts: 0,
              errors: ['Invalid format: Expected "accounts" array'],
            })
          }
        } catch (error) {
          setValidationResult({
            valid: false,
            accounts: 0,
            errors: ['Invalid JSON file format'],
          })
        }
      }
      reader.readAsText(file)
    }
  }

  const handleJsonValidation = () => {
    try {
      const parsed = JSON.parse(jsonData)

      // Validate JSON structure
      if (parsed.accounts && Array.isArray(parsed.accounts)) {
        const validAccounts = parsed.accounts.filter((acc: any) =>
          acc.name && acc.accountId && acc.roleArn
        )

        const errors = []
        if (parsed.accounts.length !== validAccounts.length) {
          errors.push('Some accounts have missing required fields (name, accountId, roleArn)')
        }

        // Check for duplicate account IDs
        const accountIds = parsed.accounts.map((acc: any) => acc.accountId)
        const duplicateIds = accountIds.filter((id: string, index: number) => accountIds.indexOf(id) !== index)
        if (duplicateIds.length > 0) {
          errors.push(`Duplicate account IDs found: ${duplicateIds.join(', ')}`)
        }

        setValidationResult({
          valid: validAccounts.length > 0 && errors.length === 0,
          accounts: validAccounts.length,
          errors,
        })
      } else {
        setValidationResult({
          valid: false,
          accounts: 0,
          errors: ['Invalid format: Expected "accounts" array'],
        })
      }
    } catch (error) {
      setValidationResult({
        valid: false,
        accounts: 0,
        errors: ["Invalid JSON format"],
      })
    }
  }

  const handleImport = async () => {
    if (!validationResult?.valid) return

    try {
      let accountsToImport: any[] = []

      if (importMethod === "file" && selectedFile) {
        const reader = new FileReader()
        reader.onload = async (e) => {
          const content = e.target?.result as string
          const parsed = JSON.parse(content)
          accountsToImport = parsed.accounts
          await processImport(accountsToImport)
        }
        reader.readAsText(selectedFile)
      } else if (importMethod === "json") {
        const parsed = JSON.parse(jsonData)
        accountsToImport = parsed.accounts
        await processImport(accountsToImport)
      }
    } catch (error) {
      console.error("Error importing accounts:", error)
    }
  }

  const processImport = async (accounts: any[]) => {
    try {
      for (const account of accounts) {
        if (account.name && account.accountId && account.roleArn) {
          await ClientAccountService.createAccount({
            name: account.name,
            accountId: account.accountId,
            roleArn: account.roleArn,
            description: account.description || '',
            environment: account.environment || 'production',
            regions: account.regions || ['us-east-1'],
            isActive: account.isActive !== false,
            createdBy: "import",
          })
        }
      }
      onOpenChange(false)
    } catch (error) {
      console.error("Error processing import:", error)
    }
  }

  const sampleJson = `{
  "accounts": [
    {
      "name": "Production Account",
      "accountId": "123456789012",
      "roleArn": "arn:aws:iam::123456789012:role/CostOptimizationRole",
      "description": "Main production environment",
      "regions": ["us-east-1", "us-west-2"],
      "tags": [
        { "key": "Environment", "value": "Production" },
        { "key": "CostCenter", "value": "CC-123" }
      ],
      "active": true
    }
  ]
}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">        <DialogHeader>
        <DialogTitle className="flex items-center space-x-2">
          <Upload className="h-5 w-5" />
          <span>Import AWS Accounts</span>
        </DialogTitle>
        <DialogDescription>Import AWS accounts from a file or JSON data</DialogDescription>
      </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-4 pr-4">

            <Tabs value={importMethod} onValueChange={(value) => setImportMethod(value as "file" | "json")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="file">Upload File</TabsTrigger>
                <TabsTrigger value="json">Paste JSON</TabsTrigger>
              </TabsList>

              <TabsContent value="file" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Upload Account File</CardTitle>
                    <CardDescription>Upload a JSON file containing AWS account configurations</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="file">Select File</Label>
                      <Input id="file" type="file" accept=".json" onChange={handleFileSelect} />
                      <p className="text-xs text-muted-foreground">Supported formats: JSON (.json)</p>
                    </div>

                    {selectedFile && (
                      <div className="p-3 bg-muted rounded-lg">
                        <div className="flex items-center space-x-2">
                          <FileText className="h-4 w-4" />
                          <span className="text-sm font-medium">{selectedFile.name}</span>
                          <span className="text-xs text-muted-foreground">
                            ({(selectedFile.size / 1024).toFixed(1)} KB)
                          </span>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="json" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Paste JSON Data</CardTitle>
                    <CardDescription>Paste your AWS account configuration in JSON format</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="json">JSON Data</Label>
                      <Textarea
                        id="json"
                        value={jsonData}
                        onChange={(e) => setJsonData(e.target.value)}
                        placeholder="Paste your JSON data here..."
                        rows={8}
                        className="font-mono text-sm"
                      />
                    </div>

                    <Button onClick={handleJsonValidation} variant="outline" size="sm">
                      Validate JSON
                    </Button>

                    <details className="space-y-2">
                      <summary className="text-sm font-medium cursor-pointer">View Sample JSON Format</summary>
                      <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto">{sampleJson}</pre>
                    </details>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>

            {/* Validation Results */}
            {validationResult && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    {validationResult.valid ? (
                      <CheckCircle className="h-5 w-5 text-success" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-destructive" />
                    )}
                    <span>Validation Results</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {validationResult.valid ? (
                    <div className="space-y-2">
                      <p className="text-sm text-success dark:text-success">✓ Valid format detected</p>
                      <p className="text-sm text-muted-foreground">
                        Found {validationResult.accounts} account{validationResult.accounts !== 1 ? "s" : ""} ready to
                        import
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm text-destructive dark:text-destructive">✗ Validation failed</p>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        {validationResult.errors.map((error, index) => (
                          <li key={index}>• {error}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={!validationResult?.valid}>
            <Upload className="mr-2 h-4 w-4" />
            Import Accounts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
