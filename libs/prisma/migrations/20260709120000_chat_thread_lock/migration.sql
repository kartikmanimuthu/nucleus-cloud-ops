-- CreateTable
CREATE TABLE "chat_thread_locks" (
    "threadId" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_thread_locks_pkey" PRIMARY KEY ("threadId")
);

-- CreateIndex
CREATE INDEX "chat_thread_locks_expiresAt_idx" ON "chat_thread_locks"("expiresAt");
