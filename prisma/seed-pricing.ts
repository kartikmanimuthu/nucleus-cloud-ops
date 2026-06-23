/**
 * Pricing catalog seed (RS-006).
 *
 * Seeds a curated set of common EC2 / RDS / EBS prices for the primary regions so the
 * right-sizing engine produces savings figures before the weekly Price List refresh
 * (RS-007) has run. Idempotent — safe to re-run; the refresh job later overwrites these.
 *
 * Prices are approximate on-demand USD (Linux/Shared, Single-AZ) and intended as a
 * bootstrap baseline, not a billing source of truth.
 *
 * Run: cd web-ui && npx ts-node --compiler-options '{"module":"CommonJS"}' ../prisma/seed-pricing.ts
 */
import { PrismaClient } from '../web-ui/node_modules/.prisma/client';

const prisma = new PrismaClient();

const REGIONS = ['ap-south-1', 'us-east-1'];
// Regional multiplier vs us-east-1 baseline (approximate).
const REGION_MULT: Record<string, number> = { 'us-east-1': 1.0, 'ap-south-1': 1.07 };

// EC2 on-demand $/hr (us-east-1 baseline) + vcpu/mem.
const EC2: Array<{ type: string; vcpu: number; mem: number; price: number; family: string }> = [
    { type: 't3.micro', vcpu: 2, mem: 1, price: 0.0104, family: 'General purpose' },
    { type: 't3.small', vcpu: 2, mem: 2, price: 0.0208, family: 'General purpose' },
    { type: 't3.medium', vcpu: 2, mem: 4, price: 0.0416, family: 'General purpose' },
    { type: 't3.large', vcpu: 2, mem: 8, price: 0.0832, family: 'General purpose' },
    { type: 't3.xlarge', vcpu: 4, mem: 16, price: 0.1664, family: 'General purpose' },
    { type: 't3.2xlarge', vcpu: 8, mem: 32, price: 0.3328, family: 'General purpose' },
    { type: 'm5.large', vcpu: 2, mem: 8, price: 0.096, family: 'General purpose' },
    { type: 'm5.xlarge', vcpu: 4, mem: 16, price: 0.192, family: 'General purpose' },
    { type: 'm5.2xlarge', vcpu: 8, mem: 32, price: 0.384, family: 'General purpose' },
    { type: 'm5.4xlarge', vcpu: 16, mem: 64, price: 0.768, family: 'General purpose' },
    { type: 'm6i.large', vcpu: 2, mem: 8, price: 0.096, family: 'General purpose' },
    { type: 'm6i.xlarge', vcpu: 4, mem: 16, price: 0.192, family: 'General purpose' },
    { type: 'm6i.2xlarge', vcpu: 8, mem: 32, price: 0.384, family: 'General purpose' },
    { type: 'c5.large', vcpu: 2, mem: 4, price: 0.085, family: 'Compute optimized' },
    { type: 'c5.xlarge', vcpu: 4, mem: 8, price: 0.17, family: 'Compute optimized' },
    { type: 'c5.2xlarge', vcpu: 8, mem: 16, price: 0.34, family: 'Compute optimized' },
    { type: 'r5.large', vcpu: 2, mem: 16, price: 0.126, family: 'Memory optimized' },
    { type: 'r5.xlarge', vcpu: 4, mem: 32, price: 0.252, family: 'Memory optimized' },
    { type: 'r5.2xlarge', vcpu: 8, mem: 64, price: 0.504, family: 'Memory optimized' },
];

// RDS on-demand $/hr (us-east-1, Single-AZ, MySQL-ish) + vcpu/mem.
const RDS: Array<{ cls: string; vcpu: number; mem: number; price: number }> = [
    { cls: 'db.t3.micro', vcpu: 2, mem: 1, price: 0.017 },
    { cls: 'db.t3.small', vcpu: 2, mem: 2, price: 0.034 },
    { cls: 'db.t3.medium', vcpu: 2, mem: 4, price: 0.068 },
    { cls: 'db.t3.large', vcpu: 2, mem: 8, price: 0.136 },
    { cls: 'db.m5.large', vcpu: 2, mem: 8, price: 0.171 },
    { cls: 'db.m5.xlarge', vcpu: 4, mem: 16, price: 0.342 },
    { cls: 'db.m5.2xlarge', vcpu: 8, mem: 32, price: 0.684 },
    { cls: 'db.r5.large', vcpu: 2, mem: 16, price: 0.24 },
    { cls: 'db.r5.xlarge', vcpu: 4, mem: 32, price: 0.48 },
];

// EBS $/GiB-month + $/IOPS-month (us-east-1 baseline).
const EBS: Array<{ type: string; gib: number; iops?: number }> = [
    { type: 'gp2', gib: 0.1 },
    { type: 'gp3', gib: 0.08, iops: 0.005 },
    { type: 'io1', gib: 0.125, iops: 0.065 },
    { type: 'io2', gib: 0.125, iops: 0.065 },
    { type: 'st1', gib: 0.045 },
    { type: 'sc1', gib: 0.015 },
    { type: 'standard', gib: 0.05 },
];

async function main() {
    let count = 0;
    for (const region of REGIONS) {
        const m = REGION_MULT[region] ?? 1.0;
        for (const e of EC2) {
            await prisma.pricingCatalogEntry.upsert({
                where: { region_serviceCode_resourceClass: { region, serviceCode: 'AmazonEC2', resourceClass: e.type } },
                update: { pricePerHour: e.price * m, attributes: { vcpu: e.vcpu, memGiB: e.mem, family: e.family } },
                create: {
                    region, serviceCode: 'AmazonEC2', resourceClass: e.type,
                    pricePerHour: e.price * m, attributes: { vcpu: e.vcpu, memGiB: e.mem, family: e.family },
                },
            });
            count++;
        }
        for (const r of RDS) {
            await prisma.pricingCatalogEntry.upsert({
                where: { region_serviceCode_resourceClass: { region, serviceCode: 'AmazonRDS', resourceClass: r.cls } },
                update: { pricePerHour: r.price * m, attributes: { vcpu: r.vcpu, memGiB: r.mem } },
                create: {
                    region, serviceCode: 'AmazonRDS', resourceClass: r.cls,
                    pricePerHour: r.price * m, attributes: { vcpu: r.vcpu, memGiB: r.mem },
                },
            });
            count++;
        }
        for (const v of EBS) {
            await prisma.pricingCatalogEntry.upsert({
                where: { region_serviceCode_resourceClass: { region, serviceCode: 'AmazonEBS', resourceClass: v.type } },
                update: { pricePerGiBMonth: v.gib * m, pricePerIopsMonth: v.iops ? v.iops * m : null },
                create: {
                    region, serviceCode: 'AmazonEBS', resourceClass: v.type,
                    pricePerGiBMonth: v.gib * m, pricePerIopsMonth: v.iops ? v.iops * m : null, attributes: {},
                },
            });
            count++;
        }
    }
    console.log(`[seed-pricing] Upserted ${count} pricing catalog entries across ${REGIONS.length} regions`);
}

main()
    .catch((e) => {
        console.error('[seed-pricing] Error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
