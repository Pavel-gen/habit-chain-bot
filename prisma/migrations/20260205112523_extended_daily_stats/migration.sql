/*
  Warnings:

  - You are about to drop the column `messageHours` on the `DailyStats` table. All the data in the column will be lost.
  - Added the required column `emotionalIntensities` to the `DailyStats` table without a default value. This is not possible if the table is not empty.
  - Added the required column `messageTimestamps` to the `DailyStats` table without a default value. This is not possible if the table is not empty.
  - Added the required column `messageWordCounts` to the `DailyStats` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sentimentScores` to the `DailyStats` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "DailyStats" DROP COLUMN "messageHours",
ADD COLUMN     "emotionalIntensities" JSONB NOT NULL,
ADD COLUMN     "messageTimestamps" JSONB NOT NULL,
ADD COLUMN     "messageWordCounts" JSONB NOT NULL,
ADD COLUMN     "sentimentScores" JSONB NOT NULL;
