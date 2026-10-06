import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities } from "./activities";
import { TASK_QUEUE } from "./config";

async function run(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const connection = await NativeConnection.connect({ address });
  // Activities use a Client to talk to the waitlist Workflow.
  const client = new Client({ connection: await Connection.connect({ address }), namespace: "default" });

  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows"),
    activities: createActivities(client),
  });
  console.log(`Worker is polling the ${TASK_QUEUE} task queue.`);
  await worker.run();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
