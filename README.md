# Agentic Test Harness

A full-stack platform for testing, evaluating, and benchmarking autonomous AI agents. Upload agent run logs, parse them through an adapter-based ingestion pipeline, and evaluate agent performance using a multi-model LLM judging panel -- all from a single dashboard.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router, Turbopack) |
| Language | TypeScript, React 19 |
| Database | PostgreSQL via Prisma ORM |
| Auth | Custom JWT-based auth (jose + bcrypt) |
| AI / LLM | Google Gemini 2.5 Flash (evaluation), Groq multi-model panel (judging), OpenAI / LangChain (test suite runs) |
| Storage | Local filesystem storage |
| Run Processing | In-process parser and judger modules |
| Styling | Tailwind CSS v4 |
| Validation | Zod v4 |
| Charts | Recharts |
| PDF Export | jsPDF + html2canvas |
| CI/CD | GitHub Actions (lint, build, SonarQube, Vercel deploy) |
| Containerization | Docker (multi-stage Node 20 Alpine) |

## Features

### Core Workflow

1. **Create Projects** -- Organize agent evaluations by project.
2. **Upload Agent Logs** -- Upload JSONL, JSON, or plain-text log files from agent runs.
3. **Parse Logs** -- An adapter-based ingestion pipeline auto-detects log formats (OpenAI Agents, LangChain, Public Data Trajectory, Generic JSONL) and extracts structured events, tool calls, steps, metrics, and rule flags.
4. **Judge Runs** -- A multi-model judging panel (6 free-tier Groq models) evaluates agent performance with median-based adjudication, confidence scoring, and per-dimension scorecards.
5. **Evaluate Runs** -- Gemini-powered evaluation scores runs across 7 dimensions on a 0-100 scale.
6. **Compare Runs** -- Select 2-4 runs for side-by-side comparison with delta indicators and dimension breakdowns.

### Interactive Test Harness

An in-browser test harness for running test suites with mock tools against OpenAI-compatible models. Includes a default "Tokyo Weekend Planner" scenario with 6 mock travel API endpoints (flights, hotels, weather, events, dining, budget).

### Custom Evaluation Rubrics

Define custom evaluation rubrics with configurable dimensions, weights, and scoring criteria. Three built-in templates (General AI Agent, Customer Service Agent, Code Generation Agent) are provided, or create your own from scratch.

### Model Budget Limits

Built-in budget validation prevents excessive API costs with configurable per-operation limits, real-time token/cost tracking, and HTTP 429 responses when budgets are exceeded. See [docs/BUDGET_LIMITS.md](docs/BUDGET_LIMITS.md) for details.

### User Management

- JWT-based authentication with httpOnly cookies
- User registration and login
- Profile management and account deletion
- Workspace-based access control (Admin/Member roles)

## Project Structure

```
src/
  app/
    api/
      auth/           # Login, signup, logout
      account/         # Profile, account deletion
      files/           # Authenticated logfile downloads
      projects/        # Project CRUD
      runs/            # Run creation, upload, parse, judge, evaluate, compare
      suites/          # Test suite CRUD
      rubrics/         # Evaluation rubric CRUD
      ingestions/      # Ingestion tracking
      tools/           # Tool management
      mock/            # 6 mock travel API endpoints (public)
      me/              # Current user info
      test-suite/      # Test suite execution (streaming), key rotation
    compare/           # Run comparison page
    delete-test-suite/ # Test suite deletion page
    limit-model-budget/# Budget configuration page
    login/             # Login page
    signup/            # Signup page
    profile/           # Profile settings page
    projects/[id]/     # Project detail page
    rubrics/           # Rubric list and creation pages
    runs/[id]/         # Individual run view page
    test-harness/      # Interactive test harness page
    components/
      projects/        # Project list, modals, run table, score chart
      runs/            # Run view, comparison view, dimension diff
      DashboardHero    # Dashboard hero section
      ProfileSettingsCard # Profile editing
      DeleteAccountModal  # Account deletion confirmation
  lib/
    auth.ts            # Server-side session extraction from JWT
    authCookie.ts      # Cookie settings for auth responses
    jwt.ts             # JWT sign/verify (HS256)
    prisma.ts          # Singleton Prisma client
    storage.ts         # Local filesystem storage helpers
    parser.ts          # In-process run parser
    judger.ts          # In-process multi-model judger
    evaluator.ts       # Gemini-based evaluation logic
    budgetValidator.ts # BudgetTracker class (token/cost tracking)
    runBudgetValidator.ts # Pre-call budget validation
    mockToolCatalog.ts # Mock tool definitions and default test suite
    testSuiteStore.ts  # In-memory test suite state
    openaiKeys.ts      # Multi-key API key rotation
    openaiModels.ts    # Multi-model configuration
    toolSchemas.ts     # Zod schemas for tools
    suiteSchemas.ts    # Zod schema for test suites
    pdf-generator.ts   # PDF report generation
    events.ts          # Event name constants
  middleware.ts        # JWT auth middleware
  types/
    evaluation.ts      # Evaluation type definitions

prisma/
  schema.prisma        # 20 models (User, Workspace, Project, AgentRun, etc.)

tests/
  budget-validation-example.ts
  fixtures/            # Sample log files (JSONL, LangChain, OpenAI Agents, Generic)

docs/
  BUDGET_ARCHITECTURE.md
  BUDGET_LIMITS.md
  IMPLEMENTATION_SUMMARY.md
```

## Database Schema

The Prisma schema defines 20 models. Key entities and their relationships:

- **User** -> **Session**, **ApiToken**, **Membership**
- **Workspace** -> **Membership** (Admin/Member) -> **Project**
- **Project** -> **AgentRun** (status lifecycle: CREATED -> UPLOADING -> UPLOADED -> PARSING -> READY_FOR_JUDGING -> JUDGING -> COMPLETED / COMPLETED_LOW_CONFIDENCE / FAILED)
- **AgentRun** -> **RunLogfile**, **RunIngestion**, **RunEvaluation**, **RunEvent**, **RunTraceSummary**, **RunMetrics**, **RunRuleFlag**, **RunJudgePacket**
- **Tool** -> **ToolVersion** -> **MockEndpoint**
- **TestSuite** -> linked to **EvaluationRubric**
- **EvaluationRubric** -> custom dimensions, weights, scoring criteria

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL database

### Installation

```bash
git clone <repository-url>
cd AgenticTestHarness_SPROJ
npm install
```

### Environment Variables

Create a `.env.local` file with the following variables:

```env
# Database (required)
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...

# Auth (required)
JWT_SECRET=your-jwt-secret
JWT_EXPIRES_DAYS=14

# Google Gemini (required for evaluation)
GOOGLE_GEMINI_API=your-gemini-api-key

# OpenAI-compatible models (required for test harness)
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://your-endpoint.example.com/v1
OPENAI_MODEL=gpt-4.1-mini

# Additional models and keys (optional, for rotation)
OPENAI_MODEL_1=gpt-4.1
OPENAI_MODEL_2=gpt-4.1-mini
OPENAI_API_KEY_1=another-api-key
OPENAI_API_KEY_2=third-api-key

# Budget limits (optional)
MAX_JUDGE_BUDGET=2.0
MAX_PARSE_BUDGET=1.0
MODEL_COST_PER_MILLION_TOKENS=0.1

# Local file storage (optional)
UPLOADS_DIR=./uploads
```

Judging additionally requires `GROQ_API_KEY` for the multi-model judging panel.

### Running Locally

```bash
# Generate Prisma client and start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Running with Docker

```bash
docker compose up --build
```

The app will be available at `http://localhost:3000` (configurable via `APP_PORT`).

### Deploying to AWS (k3s)

Production runs on a single-node self-managed [k3s](https://k3s.io) cluster on one free-tier-eligible AWS EC2 instance, running 2 app replicas for basic redundancy. k3s's built-in ServiceLB load-balances between them — there's no AWS ELB/ALB involved.

This app has negligible traffic, and AWS has no way to run an internet-facing instance at literal $0 (see cost note below), so this intentionally provisions the minimum — one node — rather than paying that same unavoidable per-IP charge multiple times over for no real benefit.

```bash
# One-time: provisions the VPC security group, the EC2 instance, and k3s
./infra/aws/provision-k3s-cluster.sh

# Day to day: stop the node when not in use, start it again later
./infra/aws/stop-cluster.sh
./infra/aws/start-cluster.sh

# Permanently tear the cluster down
./infra/aws/teardown-cluster.sh
```

After provisioning, create the `app-secrets` Kubernetes Secret (see `k8s/secrets.example.yaml`) and set the `KUBE_CONFIG` / `PRODUCTION_URL` GitHub Actions secrets as printed by the provisioning script. From then on, every push to `main` that passes CI is deployed automatically by `cd.yml`.

**Cost note:** instance-hours for a single always-on t3.micro/t2.micro fit inside AWS's free-tier allowance (750 hrs/month). The one unavoidable cost is the public IPv4 address itself — as of AWS's Feb 2024 pricing change, every public IPv4 costs ~$0.005/hr (~$3.65/month) even while just attached to a running instance, with no free-tier exception. That's the realistic floor for any internet-facing AWS setup, single node or otherwise. Run `stop-cluster.sh` when you're not using it to release the IP and avoid even that charge while idle.

### Database Setup

```bash
# Push schema to database
npx prisma db push

# Or run migrations
npx prisma migrate dev
```

## Run Processing Pipeline

Two server-side modules handle parsing and judging:

- **`src/lib/parser.ts`** -- Downloads log files from local storage, auto-detects format, runs adapter-based ingestion (OpenAI Agents, LangChain, Public Data Trajectory, Generic JSONL), extracts events and metrics, builds judge packets, and stores structured results in the database.

- **`src/lib/judger.ts`** -- Multi-model evaluation panel using 6 free-tier Groq models (llama-3.3-70b, llama-3.1-8b, compound-mini, compound, llama-4-scout, qwen3-32b) plus a verifier model. Produces per-dimension scorecards with reasoning, evidence, and confidence scores via median-based adjudication. Supports custom rubrics.

## CI/CD

Three GitHub Actions workflows:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push to `main`, PRs | Lint, test, and build validation |
| `cd.yml` | After successful CI on `main` | Build + push Docker image, deploy to the AWS k3s cluster, health-check, auto-rollback |
| `build.yml` | Push/PR | SonarQube code quality scan |

(Vercel deploys its own preview/production builds automatically via its GitHub App integration — that's separate from these workflows and untouched by them.)

## API Routes

| Route | Methods | Description |
|-------|---------|-------------|
| `/api/auth/login` | POST | User login |
| `/api/auth/signup` | POST | User registration |
| `/api/auth/logout` | POST | User logout |
| `/api/account/profile` | GET, PUT | Profile management |
| `/api/account/delete` | DELETE | Account deletion |
| `/api/me` | GET | Current user info |
| `/api/projects` | GET, POST | List and create projects |
| `/api/projects/[id]` | GET, PUT, DELETE | Project CRUD |
| `/api/runs` | POST | Create a new run |
| `/api/runs/[id]` | GET | Get run details |
| `/api/runs/upload-logfile` | POST | Upload log file for a run |
| `/api/runs/upload-complete` | POST | Mark upload as complete |
| `/api/runs/[id]/parse` | POST | Trigger log parsing |
| `/api/runs/[id]/judge` | POST | Trigger multi-model judging |
| `/api/runs/[id]/evaluate` | POST | Trigger Gemini evaluation |
| `/api/runs/compare` | GET | Compare multiple runs |
| `/api/suites` | GET | List test suites |
| `/api/test-suite` | GET, POST, PUT, DELETE | Test suite CRUD |
| `/api/test-suite/run` | POST | Execute test suite (streaming) |
| `/api/test-suite/rotate-key` | POST | Rotate OpenAI API key |
| `/api/rubrics` | GET, POST | List and create rubrics |
| `/api/rubrics/[id]` | GET, PUT, DELETE | Rubric CRUD |
| `/api/ingestions` | GET | List ingestions |
| `/api/tools/[id]` | GET | Get tool details |
| `/api/mock/*` | GET | 6 mock travel API endpoints (public) |

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with Turbopack |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm run lint` | Run ESLint |

Prisma client generation runs automatically via `predev`, `prebuild`, `prestart`, and `postinstall` hooks.

## Documentation

- [Budget Architecture](docs/BUDGET_ARCHITECTURE.md) -- Architecture diagrams for the budget validation system
- [Budget Limits](docs/BUDGET_LIMITS.md) -- Feature documentation for budget limiting
- [Implementation Summary](docs/IMPLEMENTATION_SUMMARY.md) -- Budget limits implementation details
- [Feature Summary](FEATURE_IMPLEMENTATION_SUMMARY.md) -- Run comparison and custom rubrics implementation details
