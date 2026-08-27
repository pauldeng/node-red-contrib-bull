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
      RED.nodes.getType("bullmq flow"),
  );

  const definitions = await page.evaluate(() => ({
    config: RED.nodes.getType("bullmq-queue-server"),
    cmd: RED.nodes.getType("bullmq cmd"),
    run: RED.nodes.getType("bullmq run"),
    job: RED.nodes.getType("bullmq job"),
    events: RED.nodes.getType("bullmq events"),
    flow: RED.nodes.getType("bullmq flow"),
  }));

  expect(definitions.config.defaults.deployment.value).toBe("single");
  expect(definitions.config.defaults.clusterNodes.value).toBe("");
  expect(definitions.config.defaults.sentinels.value).toBe("");
  expect(definitions.run.defaults.completionMode.value).toBe("immediate");
  expect(definitions.run.defaults.ackTimeout.value).toBe(300000);
  expect(definitions.run.defaults.maxStartedAttempts.value).toBe(100);
  expect(definitions.job.defaults.action.value).toBe("complete");
  expect(definitions.events.defaults.events.value).toBe("");
  expect(definitions.flow.defaults.queue.type).toBe("bullmq-queue-server");
  expect(definitions.cmd.defaults.queue.type).toBe("bullmq-queue-server");
});

test("loads BullMQ config and worker editor templates", async ({ page }) => {
  await page.goto("/");
  const configTemplate = await page
    .locator('script[data-template-name="bullmq-queue-server"]')
    .textContent();
  const runTemplate = await page
    .locator('script[data-template-name="bullmq run"]')
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
    "node-input-maxStartedAttempts",
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
      RED.nodes.getType("bullmq run") &&
      RED.workspaces.active() &&
      loader &&
      getComputedStyle(loader).display === "none"
    );
  });

  await page.evaluate(() => {
    const definition = RED.nodes.getType("bullmq run");
    const node = {
      id: RED.nodes.id(),
      type: "bullmq run",
      z: RED.workspaces.active(),
      _def: definition,
      name: "",
      queue: "",
      completionMode: "immediate",
      ackTimeout: 300000,
      concurrency: 1,
      maxStartedAttempts: 100,
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
  await expect(page.locator("#node-input-maxStartedAttempts")).toHaveValue(
    "100",
  );
  await expect(page.locator(".bull-ack-timeout-row")).toBeHidden();
  await page.locator("#node-input-completionMode").selectOption("manual");
  await expect(page.locator(".bull-ack-timeout-row")).toBeVisible();
  await page.locator("#node-dialog-cancel").click();

  await page.evaluate(() => {
    RED.editor.editConfig("", "bullmq-queue-server", "_ADD_");
  });
  await expect(page.locator("#node-config-input-deployment")).toBeVisible();
  await page.locator("#node-config-input-deployment").selectOption("cluster");
  await expect(page.locator(".bull-db-row")).toBeHidden();
  await page.locator("#node-config-input-deployment").selectOption("sentinel");
  await expect(page.locator(".bull-db-row")).toBeVisible();
  await page.locator("#node-config-dialog-cancel").click();
});

test("telemetry fields toggle their rows and persist across dialog close and reopen", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => {
    const loader = document.querySelector("#red-ui-loading-progress");
    return (
      window.RED &&
      RED.nodes.getType("bullmq-queue-server") &&
      RED.workspaces.active() &&
      loader &&
      getComputedStyle(loader).display === "none"
    );
  });

  await page.evaluate(() => {
    RED.editor.editConfig("", "bullmq-queue-server", "_ADD_");
  });

  await expect(page.locator("#node-config-input-telemetry")).toBeVisible();
  await expect(
    page.locator("#node-config-input-telemetryServiceName"),
  ).toBeHidden();
  await expect(
    page.locator("#node-config-input-telemetryMetrics"),
  ).toBeHidden();

  await page.locator("#node-config-input-name").fill("telemetry-queue");
  await page.locator("#node-config-input-telemetry").check();
  await expect(
    page.locator("#node-config-input-telemetryServiceName"),
  ).toBeVisible();
  await expect(
    page.locator("#node-config-input-telemetryMetrics"),
  ).toBeVisible();

  await page
    .locator("#node-config-input-telemetryServiceName")
    .fill("my-otel-service");
  await page.locator("#node-config-input-telemetryMetrics").check();

  await page.locator("#node-config-dialog-ok").click();
  await expect(page.locator("#node-config-dialog-ok")).toHaveCount(0);

  const configId = await page.evaluate(() => {
    let id;
    RED.nodes.eachConfig((node) => {
      if (
        node.type === "bullmq-queue-server" &&
        node.name === "telemetry-queue"
      ) {
        id = node.id;
      }
    });
    return id;
  });
  expect(configId).toBeTruthy();

  await page.evaluate((id) => {
    RED.editor.editConfig("", "bullmq-queue-server", id);
  }, configId);

  await expect(page.locator("#node-config-input-telemetry")).toBeChecked();
  await expect(
    page.locator("#node-config-input-telemetryServiceName"),
  ).toBeVisible();
  await expect(
    page.locator("#node-config-input-telemetryServiceName"),
  ).toHaveValue("my-otel-service");
  await expect(
    page.locator("#node-config-input-telemetryMetrics"),
  ).toBeChecked();

  await page.locator("#node-config-dialog-cancel").click();
});

test("auto-removal fields are prefilled with bounded defaults and persist", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => {
    const loader = document.querySelector("#red-ui-loading-progress");
    return (
      window.RED &&
      RED.nodes.getType("bullmq-queue-server") &&
      RED.workspaces.active() &&
      loader &&
      getComputedStyle(loader).display === "none"
    );
  });

  await page.evaluate(() => {
    RED.editor.editConfig("", "bullmq-queue-server", "_ADD_");
  });

  // A new queue must arrive bounded: blank fields keep every job forever.
  await expect(page.locator("#node-config-input-removeOnComplete")).toHaveValue(
    "1000",
  );
  await expect(page.locator("#node-config-input-removeOnFail")).toHaveValue(
    "5000",
  );

  // Rejecting -1 or 1.5 is deliberately NOT asserted here. Node-RED only adds
  // its input-error class once the dialog's own change/keyup handlers are
  // attached, so racing them made this test fail about one run in three. The
  // same guarantee is pinned deterministically instead: editor-contract
  // asserts both fields declare validate: validateKeepCount, and
  // connections.test.js asserts the runtime rejects a negative count.

  await page.locator("#node-config-input-name").fill("retention-queue");
  await page.locator("#node-config-input-removeOnComplete").fill("25");
  await page.locator("#node-config-input-removeOnFail").fill("");
  await page.locator("#node-config-dialog-ok").click();
  await expect(page.locator("#node-config-dialog-ok")).toHaveCount(0);

  const stored = await page.evaluate(() => {
    let found = null;
    RED.nodes.eachConfig((config) => {
      if (
        config.type === "bullmq-queue-server" &&
        config.name === "retention-queue"
      ) {
        found = {
          complete: config.removeOnComplete,
          fail: config.removeOnFail,
        };
      }
    });
    return found;
  });
  expect(stored).toEqual({ complete: "25", fail: "" });
});

async function openEditor(page) {
  await page.goto("/");
  await page.waitForFunction(() => {
    const loader = document.querySelector("#red-ui-loading-progress");
    return (
      window.RED &&
      RED.nodes.getType("bullmq-queue-server") &&
      RED.workspaces.active() &&
      loader &&
      getComputedStyle(loader).display === "none"
    );
  });
}

test("PostgreSQL backend toggles its rows, keeps per-backend ports, and persists", async ({
  page,
}) => {
  await openEditor(page);
  await page.evaluate(() => {
    RED.editor.editConfig("", "bullmq-queue-server", "_ADD_");
  });

  // Redis is the default backend, so its topology rows own the dialog.
  await expect(page.locator("#node-config-input-backend")).toHaveValue("redis");
  await expect(page.locator("#node-config-input-deployment")).toBeVisible();
  await expect(page.locator("#node-config-input-prefix")).toBeVisible();
  await expect(page.locator("#node-config-input-database")).toBeHidden();
  await expect(page.locator("#node-config-input-port")).toHaveValue("6379");

  await page.locator("#node-config-input-backend").selectOption("postgres");

  // Redis-shaped rows give way to the database rows; host and port are shared
  // and must stay, since PostgreSQL needs them too.
  await expect(page.locator("#node-config-input-deployment")).toBeHidden();
  await expect(page.locator("#node-config-input-prefix")).toBeHidden();
  await expect(page.locator("#node-config-input-db")).toBeHidden();
  await expect(page.locator("#node-config-input-address")).toBeVisible();
  await expect(page.locator("#node-config-input-port")).toBeVisible();
  await expect(page.locator("#node-config-input-database")).toBeVisible();
  await expect(page.locator("#node-config-input-schema")).toBeVisible();
  await expect(page.locator("#node-config-input-max")).toBeVisible();
  await expect(page.locator("#node-config-input-migrate")).toBeVisible();

  // The shared port field follows the backend, and migrations match the
  // runtime default rather than an unchecked box.
  await expect(page.locator("#node-config-input-port")).toHaveValue("5432");
  await expect(page.locator("#node-config-input-migrate")).toBeChecked();

  // Each backend keeps its own value while the dialog is open. Using 5432 as
  // a deliberate Redis port pins the collision with PostgreSQL's default.
  await page.locator("#node-config-input-backend").selectOption("redis");
  await page.locator("#node-config-input-port").fill("5432");
  await page.locator("#node-config-input-backend").selectOption("postgres");
  await page.locator("#node-config-input-port").fill("15432");
  await page.locator("#node-config-input-backend").selectOption("redis");
  await expect(page.locator("#node-config-input-port")).toHaveValue("5432");
  await page.locator("#node-config-input-backend").selectOption("postgres");
  await expect(page.locator("#node-config-input-port")).toHaveValue("15432");

  await page.locator("#node-config-input-name").fill("postgres-queue");
  await page.locator("#node-config-input-port").fill("5432");
  await page.locator("#node-config-input-database").fill("bullmq");
  await page.locator("#node-config-input-schema").fill("jobs");
  await page.locator("#node-config-input-max").fill("4");
  await page.locator("#node-config-input-migrate").uncheck();
  await page.locator("#node-config-input-password").fill("pg-password-secret");
  await page.locator("#node-config-input-tls").check();
  await page
    .locator("#node-config-input-tlsCert")
    .fill("pg-client-cert-secret");

  await page.locator("#node-config-dialog-ok").click();
  await expect(page.locator("#node-config-dialog-ok")).toHaveCount(0);

  const configId = await page.evaluate(() => {
    let id;
    RED.nodes.eachConfig((node) => {
      if (
        node.type === "bullmq-queue-server" &&
        node.name === "postgres-queue"
      ) {
        id = node.id;
      }
    });
    return id;
  });
  expect(configId).toBeTruthy();

  const exportedFlows = JSON.stringify(
    await (await page.request.get("/flows")).json(),
  );
  expect(exportedFlows).not.toContain("pg-password-secret");
  expect(exportedFlows).not.toContain("pg-client-cert-secret");

  await page.evaluate((id) => {
    RED.editor.editConfig("", "bullmq-queue-server", id);
  }, configId);

  await expect(page.locator("#node-config-input-backend")).toHaveValue(
    "postgres",
  );
  await expect(page.locator("#node-config-input-database")).toHaveValue(
    "bullmq",
  );
  await expect(page.locator("#node-config-input-schema")).toHaveValue("jobs");
  await expect(page.locator("#node-config-input-max")).toHaveValue("4");
  await expect(page.locator("#node-config-input-migrate")).not.toBeChecked();
  await expect(page.locator("#node-config-input-deployment")).toBeHidden();

  await page.locator("#node-config-dialog-cancel").click();
});

test("Redis ignores an invalid hidden PostgreSQL pool size", async ({
  page,
}) => {
  await openEditor(page);
  await page.evaluate(() => {
    RED.editor.editConfig("", "bullmq-queue-server", "_ADD_");
  });

  await page.locator("#node-config-input-name").fill("redis-hidden-pg");
  await page.locator("#node-config-input-backend").selectOption("postgres");
  await page.locator("#node-config-input-max").fill("0");
  await page.locator("#node-config-input-backend").selectOption("redis");
  await page.locator("#node-config-dialog-ok").click();
  await expect(page.locator("#node-config-dialog-ok")).toHaveCount(0);

  // The dialog closing proves nothing on its own: Node-RED marks a node
  // invalid rather than blocking OK. Read the node's own validity, which is
  // what paints the error triangle on every node using this config -- and the
  // Pool Max row is hidden on Redis, so there would be no field to correct.
  const state = await page.evaluate(() => {
    let found;
    RED.nodes.eachConfig((node) => {
      if (
        node.type === "bullmq-queue-server" &&
        node.name === "redis-hidden-pg"
      ) {
        found = node;
      }
    });
    return { backend: found.backend, max: found.max, valid: found.valid };
  });
  expect(state.backend).toBe("redis");
  expect(state.max).toBe("0");
  expect(state.valid).not.toBe(false);
});

test("a config saved without a backend property reopens as Redis with migrations on", async ({
  page,
}) => {
  await openEditor(page);

  // Build the node through Node-RED's own dialog, then strip the two
  // properties the backend selector introduced. That is exactly what a flow
  // saved before it existed looks like on disk, and editor defaults never
  // migrate saved JSON.
  await page.evaluate(() => {
    RED.editor.editConfig("", "bullmq-queue-server", "_ADD_");
  });
  await expect(page.locator("#node-config-input-name")).toBeVisible();
  await page.locator("#node-config-input-name").fill("legacy-queue");
  await page.locator("#node-config-dialog-ok").click();
  await expect(page.locator("#node-config-dialog-ok")).toHaveCount(0);

  const configId = await page.evaluate(() => {
    let id;
    RED.nodes.eachConfig((node) => {
      if (node.type === "bullmq-queue-server" && node.name === "legacy-queue") {
        id = node.id;
      }
    });
    const node = RED.nodes.node(id);
    delete node.backend;
    delete node.migrate;
    return id;
  });
  expect(configId).toBeTruthy();

  // Opening a legacy node must present the runtime's own defaults, not blanks.
  await page.evaluate((id) => {
    RED.editor.editConfig("", "bullmq-queue-server", id);
  }, configId);
  await expect(page.locator("#node-config-input-name")).toBeVisible();

  await expect(
    page.locator("#node-config-input-backend"),
    "a flow with no backend property must read as Redis",
  ).toHaveValue("redis");
  await expect(page.locator("#node-config-input-deployment")).toBeVisible();
  await expect(page.locator("#node-config-input-database")).toBeHidden();
  // The runtime treats a missing migrate as enabled; the box must agree, or
  // simply reopening and saving a legacy flow would silently turn it off.
  await expect(page.locator("#node-config-input-migrate")).toBeChecked();

  // Saving is where a wrong default would become permanent, so persist it and
  // read the node back.
  await page.locator("#node-config-dialog-ok").click();
  await expect(page.locator("#node-config-dialog-ok")).toHaveCount(0);

  const saved = await page.evaluate((id) => {
    const node = RED.nodes.node(id);
    return { backend: node.backend, migrate: node.migrate };
  }, configId);
  expect(saved.backend).toBe("redis");
  expect(saved.migrate).toBe(true);
});
