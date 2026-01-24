/*
  Warnings:

  - The values [bot] on the enum `Sender` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "MessageMode" AS ENUM ('regular', 'analyze', 'core');

-- AlterEnum
BEGIN;
CREATE TYPE "Sender_new" AS ENUM ('assistant', 'user');
ALTER TABLE "Message" ALTER COLUMN "sender" TYPE "Sender_new" USING ("sender"::text::"Sender_new");
ALTER TYPE "Sender" RENAME TO "Sender_old";
ALTER TYPE "Sender_new" RENAME TO "Sender";
DROP TYPE "public"."Sender_old";
COMMIT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "mode" "MessageMode" NOT NULL DEFAULT 'regular';

-- CreateIndex
CREATE INDEX "Message_mode_idx" ON "Message"("mode");
