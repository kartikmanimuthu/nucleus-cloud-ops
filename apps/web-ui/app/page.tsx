import Link from "next/link";
import { Cloud, Clock, Bot, BarChart3, Shield, Globe, Check, ArrowRight, Zap, Database, Cable, BookOpen, Activity, Github } from "lucide-react";

const features = [
  {
    icon: Clock,
    title: "Cost Scheduler",
    description: "Automatically start/stop EC2, RDS, and ECS resources on custom schedules. Save up to 70% on idle dev/staging costs with business-hours scheduling.",
  },
  {
    icon: Globe,
    title: "Multi-Account Management",
    description: "Manage 90+ AWS accounts from a single pane of glass using secure cross-account IAM roles. Grid and table views with filtering.",
  },
  {
    icon: Bot,
    title: "AI Ops Agent",
    description: "Natural language cloud operations powered by Claude Sonnet 4.6 via AWS Bedrock. Plan → Execute → Reflect → Revise with auto-approve mode.",
  },
  {
    icon: Zap,
    title: "Agent Ops",
    description: "Background agent executions triggered by Slack, Jira, API, or schedule. Full run history with execution details and status tracking.",
  },
  {
    icon: Database,
    title: "Inventory Discovery",
    description: "Auto-discover 31,000+ AWS resources across all connected accounts. Filter by type, region, account. Export and Ask AI about your inventory.",
  },
  {
    icon: BookOpen,
    title: "Knowledge Base",
    description: "Vector-powered knowledge base with S3, Bitbucket, and document sources. Ask natural language questions against your infrastructure docs.",
  },
  {
    icon: Cable,
    title: "Channels & Integrations",
    description: "Slack slash commands, Jira automation triggers, and 16+ MCP servers. Receive agent results directly in your existing workflows.",
  },
  {
    icon: Activity,
    title: "Audit Trail",
    description: "Complete audit logging with 30-day retention, advanced filtering by user/action/severity, chart view, and CSV export for compliance.",
  },
  {
    icon: BarChart3,
    title: "Cost Tracking",
    description: "Real-time savings estimation across all schedules. Dashboard shows monthly savings, active schedules, and resource counts at a glance.",
  },
  {
    icon: Shield,
    title: "RBAC & Security",
    description: "Role-based access control with viewer, operator, and admin roles. All cross-account ops use STS AssumeRole — no stored credentials.",
  },
  {
    icon: Cloud,
    title: "Deep AI Agent",
    description: "Extended thinking agent with MongoDB persistence for long-running, multi-step cloud operations that require deeper reasoning.",
  },
  {
    icon: Globe,
    title: "Appearance & Theming",
    description: "Light/dark mode, 10 color themes (Zinc, Blue, Violet, Rose…), font selection, and border radius — fully customizable per user.",
  },
];

export default function MarketingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="border-b border-border sticky top-0 bg-background/80 backdrop-blur z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-lg">
            <Zap className="w-5 h-5 text-primary" />
            Nucleus Ops
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
            <Link href="#features" className="hover:text-foreground transition-colors">Features</Link>
            <Link href="#open-source" className="hover:text-foreground transition-colors">Open Source</Link>
            <Link href="/docs" className="hover:text-foreground transition-colors">Docs</Link>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="https://github.com/kartikmanimuthu/nucleus-cloud-ops"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
            >
              <Github className="w-4 h-4" />
              GitHub
            </Link>
            <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Sign in
            </Link>
            <Link href="/docs/getting-started" className="text-sm bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-lg transition-colors">
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 text-center">
        <div className="inline-flex flex-wrap items-center justify-center gap-2 mb-6">
          <span className="inline-flex items-center gap-2 bg-primary/10 text-primary text-xs font-medium px-3 py-1.5 rounded-full">
            <Github className="w-3 h-3" />
            Open Source · MIT License
          </span>
          <span className="inline-flex items-center gap-2 bg-primary/10 text-primary text-xs font-medium px-3 py-1.5 rounded-full">
            <Zap className="w-3 h-3" />
            AWS Bedrock + Claude Sonnet 4.6
          </span>
        </div>
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight mb-6 leading-tight">
          Self-hosted AI Ops<br />
          <span className="text-primary">for AWS</span>
        </h1>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
          Stop paying for idle cloud resources. Nucleus Ops automates EC2, RDS, and ECS scheduling across all your AWS accounts — with an AI agent that speaks your language. Free, open source, and running on infrastructure you own.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link href="/docs/installation" className="inline-flex items-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-3 rounded-lg font-medium transition-colors">
            Deploy your own <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="https://github.com/kartikmanimuthu/nucleus-cloud-ops"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border border-border hover:border-foreground/40 px-6 py-3 rounded-lg font-medium transition-colors"
          >
            <Github className="w-4 h-4" />
            View on GitHub
          </Link>
        </div>

        {/* Stats */}
        <div className="mt-20 grid grid-cols-2 md:grid-cols-4 gap-8 max-w-2xl mx-auto">
          {[
            { value: "~70%", label: "off idle non-prod compute" },
            { value: "91", label: "AWS accounts in production" },
            { value: "31K+", label: "resources under management" },
            { value: "MIT", label: "open source license" },
          ].map((stat) => (
            <div key={stat.label}>
              <div className="text-3xl font-bold text-primary">{stat.value}</div>
              <div className="text-sm text-muted-foreground mt-1">{stat.label}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-6">
          Account and resource counts are from the maintainer&rsquo;s production deployment. Savings reflect shutting non-production resources outside a 50-hour work week.
        </p>
      </section>

      {/* Demo screenshot placeholder */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="rounded-2xl border border-border bg-muted overflow-hidden shadow-2xl">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-card">
            <div className="w-3 h-3 rounded-full bg-red-400" />
            <div className="w-3 h-3 rounded-full bg-yellow-400" />
            <div className="w-3 h-3 rounded-full bg-green-400" />
            <span className="ml-2 text-xs text-muted-foreground">localhost:3001/app/dashboard</span>
          </div>
          <div className="p-8 grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Total Schedules", value: "22", color: "text-primary" },
              { label: "AWS Accounts", value: "91", color: "text-green-600" },
              { label: "Resources Discovered", value: "31,139", color: "text-emerald-600" },
              { label: "Agent Runs", value: "43", color: "text-purple-600" },
            ].map((card) => (
              <div key={card.label} className="bg-card rounded-xl p-4 border border-border">
                <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
                <div className="text-xs text-muted-foreground mt-1">{card.label}</div>
              </div>
            ))}
          </div>
          <div className="px-8 pb-8">
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="text-xs font-medium text-muted-foreground mb-3">AI Ops Agent — Plan → Execute → Reflect → Revise</div>
              <div className="space-y-2">
                <div className="bg-muted rounded-lg px-3 py-2 text-sm w-fit">Review the Cost of the AWS Account for the last 3 months and share the key movers and optimization scope</div>
                <div className="bg-primary/10 rounded-lg px-3 py-2 text-sm text-primary ml-auto w-fit max-w-sm">
                  Analyzed <strong>91 accounts</strong> across ap-south-1. Top cost driver: EC2 instances running 24/7 in non-prod. Estimated savings: <strong>$4,200/month</strong> with business-hours scheduling.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="bg-muted py-24">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold mb-4">Everything you need to tame AWS costs</h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              From automated scheduling to AI-powered insights, Nucleus Ops handles the operational overhead so your team can focus on shipping.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f) => (
              <div key={f.title} className="bg-card rounded-xl p-6 border border-border">
                <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
                  <f.icon className="w-5 h-5 text-primary" />
                </div>
                <h3 className="font-semibold mb-2">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Open Source */}
      <section id="open-source" className="py-24">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary text-xs font-medium px-3 py-1.5 rounded-full mb-4">
              <Github className="w-3 h-3" />
              Proudly Open Source
            </div>
            <h2 className="text-3xl font-bold mb-4">The whole product. MIT licensed.</h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              There is no paid tier, no feature gate, and no &ldquo;open core&rdquo; split. Everything you see here is in the repository — self-host it on your own AWS account, contribute to it, or fork it.
            </p>
          </div>
          <div className="max-w-3xl mx-auto rounded-2xl border border-border bg-card p-8">
            <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-3 mb-8">
              {[
                "Every feature included",
                "Unlimited AWS accounts",
                "Unlimited schedules and agent runs",
                "AI Ops Agent + Agent Ops",
                "Inventory discovery & right-sizing",
                "Knowledge Base (pgvector RAG)",
                "Slack, Jira, Telegram & MCP",
                "RBAC, multi-tenancy & audit logs",
                "Full source code access",
                "No telemetry, no phone-home",
              ].map((feat) => (
                <li key={feat} className="flex items-center gap-2 text-sm">
                  <Check className="w-4 h-4 flex-shrink-0 text-green-500" />
                  {feat}
                </li>
              ))}
            </ul>
            <div className="flex flex-col sm:flex-row gap-3">
              <Link
                href="/docs/installation"
                className="flex-1 block text-center py-2.5 rounded-lg font-medium text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Read the install guide
              </Link>
              <Link
                href="https://github.com/kartikmanimuthu/nucleus-cloud-ops"
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 inline-flex items-center justify-center gap-2 text-center py-2.5 rounded-lg font-medium text-sm border border-border hover:border-foreground/40 transition-colors"
              >
                <Github className="w-4 h-4" />
                Browse the source
              </Link>
            </div>
            <p className="text-xs text-muted-foreground mt-6 text-center">
              A managed hosting option may come later for teams who&rsquo;d rather not run it themselves. It would run this same MIT-licensed codebase — self-hosting will never be the crippled tier.
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-primary py-20">
        <div className="max-w-3xl mx-auto px-6 text-center text-primary-foreground">
          <h2 className="text-3xl font-bold mb-4">Ready to cut your AWS bill?</h2>
          <p className="text-primary-foreground/70 mb-8">Clone it, run it, and connect your first AWS account in under 5 minutes. Free and open source.</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/docs/installation" className="inline-flex items-center gap-2 bg-background text-primary hover:bg-background/90 px-8 py-3 rounded-lg font-medium transition-colors">
              Deploy your own <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="https://github.com/kartikmanimuthu/nucleus-cloud-ops"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 border border-primary-foreground/30 hover:border-primary-foreground/60 text-primary-foreground px-8 py-3 rounded-lg font-medium transition-colors"
            >
              <Github className="w-4 h-4" />
              Star on GitHub
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-10">
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <Zap className="w-4 h-4 text-primary" />
            Nucleus Ops
          </div>
          <div className="flex gap-6">
            <Link href="/docs" className="hover:text-foreground transition-colors">Docs</Link>
            <Link href="/docs/getting-started" className="hover:text-foreground transition-colors">Getting Started</Link>
            <Link
              href="https://github.com/kartikmanimuthu/nucleus-cloud-ops"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors flex items-center gap-1"
            >
              <Github className="w-3.5 h-3.5" />
              GitHub
            </Link>
            <Link href="/login" className="hover:text-foreground transition-colors">Sign in</Link>
          </div>
          <div>© {new Date().getFullYear()} Nucleus Ops. MIT License.</div>
        </div>
      </footer>
    </div>
  );
}
