import type { BatchPublishResult, PublishResult } from "../../src/core/types.js";

const httpResult = {
  size: 1,
  attempts: 1,
  status: 202,
} satisfies BatchPublishResult;

const transportFailure = {
  size: 1,
  attempts: 3,
  status: null,
  failure: "timeout",
} satisfies BatchPublishResult;

const publishResult: PublishResult = {
  accepted: false,
  submittedUrls: 2,
  batches: [httpResult, transportFailure],
};

void publishResult;

// @ts-expect-error A received HTTP status cannot have a transport failure.
const httpResultWithFailure: BatchPublishResult = { size: 1, attempts: 1, status: 500, failure: "network" };

// @ts-expect-error A missing HTTP response must identify the transport failure.
const transportFailureWithoutKind: BatchPublishResult = { size: 1, attempts: 1, status: null };

void httpResultWithFailure;
void transportFailureWithoutKind;
