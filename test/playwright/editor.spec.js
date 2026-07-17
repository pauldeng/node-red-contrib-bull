const { expect, test } = require("@playwright/test");

test("loads BullMQ node definitions in the Node-RED editor", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(
    () =>
      window.RED &&
      RED.nodes &&
      RED.nodes.getType &&
      RED.nodes.getType("bull flow"),
  );

  const definitions = await page.evaluate(() => ({
    config: RED.nodes.getType("bull-queue-server"),
    cmd: RED.nodes.getType("bull cmd"),
    run: RED.nodes.getType("bull run"),
    job: RED.nodes.getType("bull job"),
    events: RED.nodes.getType("bull events"),
    flow: RED.nodes.getType("bull flow"),
  }));

  expect(definitions.config.defaults.deployment.value).toBe("single");
  expect(definitions.config.defaults.clusterNodes.value).toBe("");
  expect(definitions.config.defaults.sentinels.value).toBe("");
  expect(definitions.run.defaults.completionMode.value).toBe("immediate");
  expect(definitions.run.defaults.ackTimeout.value).toBe(300000);
  expect(definitions.job.defaults.action.value).toBe("complete");
  expect(definitions.events.defaults.events.value).toBe("");
  expect(definitions.flow.defaults.queue.type).toBe("bull-queue-server");
  expect(definitions.cmd.defaults.queue.type).toBe("bull-queue-server");
});

test("loads BullMQ config and worker editor templates", async ({ page }) => {
  await page.goto("/");
  const configTemplate = await page
    .locator('script[data-template-name="bull-queue-server"]')
    .textContent();
  const runTemplate = await page
    .locator('script[data-template-name="bull run"]')
    .textContent();

  for (const id of [
    "node-config-input-deployment",
    "node-config-input-clusterNodes",
    "node-config-input-sentinels",
    "node-config-input-sentinelMasterName",
    "node-config-input-tlsRejectUnauthorized",
    "node-config-input-prefix",
  ]) {
    expect(configTemplate).toContain(id);
  }

  for (const id of [
    "node-input-completionMode",
    "node-input-ackTimeout",
    "node-input-concurrency",
    "node-input-limiterMax",
    "node-input-limiterDuration",
  ]) {
    expect(runTemplate).toContain(id);
  }
});

test("toggles deployment and completion-specific rows", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => {
    const loader = document.querySelector("#red-ui-loading-progress");
    return (
      window.RED &&
      RED.nodes.getType("bull run") &&
      RED.workspaces.active() &&
      loader &&
      getComputedStyle(loader).display === "none"
    );
  });

  await page.evaluate(() => {
    const definition = RED.nodes.getType("bull run");
    const node = {
      id: RED.nodes.id(),
      type: "bull run",
      z: RED.workspaces.active(),
      _def: definition,
      name: "",
      queue: "",
      completionMode: "immediate",
      ackTimeout: 300000,
      concurrency: 1,
      limiterMax: "",
      limiterDuration: "",
      inputs: definition.inputs,
      outputs: definition.outputs,
      x: 100,
      y: 100,
      wires: [[]],
    };
    RED.nodes.add(node);
    RED.editor.edit(node);
  });
  await expect(page.locator("#node-input-completionMode")).toBeVisible();
  await expect(page.locator(".bull-ack-timeout-row")).toBeHidden();
  await page.locator("#node-input-completionMode").selectOption("manual");
  await expect(page.locator(".bull-ack-timeout-row")).toBeVisible();
  await page.locator("#node-dialog-cancel").click();

  await page.evaluate(() => {
    RED.editor.editConfig("", "bull-queue-server", "_ADD_");
  });
  await expect(page.locator("#node-config-input-deployment")).toBeVisible();
  await page.locator("#node-config-input-deployment").selectOption("cluster");
  await expect(page.locator(".bull-db-row")).toBeHidden();
  await page.locator("#node-config-input-deployment").selectOption("sentinel");
  await expect(page.locator(".bull-db-row")).toBeVisible();
  await page.locator("#node-config-dialog-cancel").click();
});
