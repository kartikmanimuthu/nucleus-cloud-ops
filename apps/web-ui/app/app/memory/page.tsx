import { Metadata } from "next";
import { MemoryClientComponent } from "@/components/memory/memory-client-component";

export const metadata: Metadata = {
    title: "Memory — Nucleus",
};

export default function MemoryPage() {
    return <MemoryClientComponent />;
}
