# Scheduler Lambda — Local Dev

## Prerequisites

```bash
# Start PostgreSQL (from repo root)
docker compose up -d postgres
```

## Run the scheduler

```bash
# From this directory: lambda/scheduler/
npm run dev                                          # full scan (all schedules)
npm run dev -- --mode=partial --scheduleId=<id>     # single schedule
```

## Truncate execution records (fresh start)

```bash
node --input-type=module <<'EOF'
import pg from 'pg';
const { Client } = pg;
const client = new Client({ connectionString: 'postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' });
await client.connect();
const result = await client.query('TRUNCATE TABLE schedule_executions');
console.log('schedule_executions truncated');
const count = await client.query('SELECT COUNT(*) FROM schedule_executions');
console.log('Rows remaining:', count.rows[0].count);
await client.end();
EOF
```

## Verify data after a run

```bash
node --input-type=module <<'EOF'
import pg from 'pg';
const { Client } = pg;
const client = new Client({ connectionString: 'postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' });
await client.connect();
const schedules = await client.query('SELECT COUNT(*) FROM schedules WHERE active = true');
const accounts  = await client.query('SELECT COUNT(*) FROM accounts WHERE active = true');
const execs     = await client.query('SELECT COUNT(*) FROM schedule_executions');
const recent    = await client.query(`
  SELECT "scheduleId", status, "executionTime", "resourcesStarted", "resourcesStopped", "resourcesFailed", duration
  FROM schedule_executions ORDER BY "executionTime" DESC LIMIT 5
`);
console.log('Active schedules:', schedules.rows[0].count);
console.log('Active accounts :', accounts.rows[0].count);
console.log('Total executions:', execs.rows[0].count);
console.log('\nLatest 5 executions:');
recent.rows.forEach(r => console.log(JSON.stringify(r)));
await client.end();
EOF
```

## Environment (.env)

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://nucleus:nucleus_dev@localhost:5432/nucleus` |
| `USE_PG_SCHEDULES` | `true` |
| `DEFAULT_TENANT_ID` | `org-default` |
| `AWS_PROFILE` | `PLATFORM-ADMIN` |
| `AWS_REGION` | `ap-south-1` |
