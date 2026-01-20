-- CreateTable
CREATE TABLE "Interaction" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "userMessageId" TEXT,
    "trigger" TEXT NOT NULL,
    "thought" TEXT NOT NULL,
    "emotionName" TEXT NOT NULL,
    "emotionIntensity" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "consequence" TEXT NOT NULL,
    "patterns" JSONB NOT NULL,
    "goal" TEXT NOT NULL,
    "ineffectivenessReason" TEXT NOT NULL,
    "hiddenNeed" TEXT NOT NULL,
    "alternatives" JSONB NOT NULL,
    "rawResponse" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Interaction_userMessageId_key" ON "Interaction"("userMessageId");

-- CreateIndex
CREATE INDEX "Interaction_userId_idx" ON "Interaction"("userId");

-- CreateIndex
CREATE INDEX "Interaction_createdAt_idx" ON "Interaction"("createdAt");

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
