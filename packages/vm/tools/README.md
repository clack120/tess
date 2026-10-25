Block counts need Entry's resolved schemas, including inherited hardware and function traits. After upgrading Entry, open a player using the installed Entry build and save this browser-console result as `snapshot.json`:

```js
copy(JSON.stringify(Object.fromEntries(Object.entries(Entry.block).filter(([, schema]) => schema).map(([name, schema]) => [name, {
  event: Boolean(schema.event),
  primitive: Boolean(schema.isPrimitive),
  params: (schema.params ?? []).map(({ type, value }) => ({ type, value })),
  statements: schema.statements?.length ?? 0,
}]))));
```

Capture before loading a work so project-specific function schemas stay out of the snapshot. Run from the repository root; the generator reads the installed Entry version itself:

```sh
bun packages/vm/tools/update-block-shapes.ts snapshot.json
```

The runtime test checks that the generated version matches the installed dependency and prints this refresh command if it is stale. Keep the snapshot outside Git.
