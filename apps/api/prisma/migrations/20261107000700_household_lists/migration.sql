-- A shopping list for the plans of several profiles of an account: each plan's list is a part of it.
-- AlterTable
ALTER TABLE "ShoppingList" ADD COLUMN     "householdId" TEXT;

-- CreateTable
CREATE TABLE "HouseholdList" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdList_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HouseholdList_userId_idx" ON "HouseholdList"("userId");

-- CreateIndex
CREATE INDEX "ShoppingList_householdId_idx" ON "ShoppingList"("householdId");

-- AddForeignKey
ALTER TABLE "ShoppingList" ADD CONSTRAINT "ShoppingList_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "HouseholdList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdList" ADD CONSTRAINT "HouseholdList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

