-- Durable learning layer: owner-specific facts the assistant adapts to over time.
CREATE TYPE "MemoryType" AS ENUM ('preference', 'contact', 'project_fact', 'pattern', 'correction', 'glossary');

CREATE TABLE "LearnedFact" (
    "id" TEXT NOT NULL,
    "type" "MemoryType" NOT NULL,
    "subject" TEXT,
    "content" TEXT NOT NULL,
    "structured" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "source" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LearnedFact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LearnedFact_type_active_idx" ON "LearnedFact"("type", "active");
