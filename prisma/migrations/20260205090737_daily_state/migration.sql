-- CreateTable
CREATE TABLE "DailyStats" (
    "id" BIGSERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 1,
    "totalMessageChars" INTEGER NOT NULL DEFAULT 0,
    "totalTypos" INTEGER NOT NULL DEFAULT 0,
    "emotions" JSONB NOT NULL,
    "topics" JSONB NOT NULL,
    "messageHours" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyStats_userId_date_key" ON "DailyStats"("userId", "date");

-- AddForeignKey
ALTER TABLE "DailyStats" ADD CONSTRAINT "DailyStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
