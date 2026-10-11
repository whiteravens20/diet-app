-- Where a background job of the administrator's stands, kept where every
-- process of the API reads the same, so that one of them runs a job and all
-- of them can say how far it is.
CREATE TABLE "JobState" (
    "name" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "stopRequested" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "JobState_pkey" PRIMARY KEY ("name")
);
