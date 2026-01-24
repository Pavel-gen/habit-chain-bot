/*
  Warnings:

  - The values [assistant] on the enum `Sender` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `mode` on the `Message` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "Sender_new" AS ENUM ('bot', 'user');
ALTER TABLE "Message" ALTER COLUMN "sender" TYPE "Sender_new" USING ("sender"::text::"Sender_new");
ALTER TYPE "Sender" RENAME TO "Sender_old";
ALTER TYPE "Sender_new" RENAME TO "Sender";
DROP TYPE "public"."Sender_old";
COMMIT;

-- DropIndex
DROP INDEX "Message_mode_idx";

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "mode";

-- DropEnum
DROP TYPE "MessageMode";
