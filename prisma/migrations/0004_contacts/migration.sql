-- Dedicated contacts: structured name/email/phone the assistant resolves
-- recipients from without re-searching Gmail each time.
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Contact_name_idx" ON "Contact"("name");
