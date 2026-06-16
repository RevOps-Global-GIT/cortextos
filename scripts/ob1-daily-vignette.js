#!/usr/bin/env node
import("./ob1-daily-vignette.mjs").catch((err) => {
  console.error(err);
  process.exit(1);
});
