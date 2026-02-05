/*
  Warnings:

  - You are about to drop the column `totalTypos` on the `DailyStats` table. All the data in the column will be lost.
  - Added the required column `typosPerMessage` to the `DailyStats` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "DailyStats" DROP COLUMN "totalTypos",
ADD COLUMN     "typosPerMessage" JSONB NOT NULL DEFAULT '[]';
