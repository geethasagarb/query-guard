# docs

`demo.gif` is an illustrated animation. It is not a screen recording.

It shows two scenes. In the first, Claude runs `sqlite3 demo.db "DELETE FROM customers"` without Query Guard. The command deletes all 1,000 rows, and the table drops to 0.

In the second, Claude runs the same command with Query Guard. Query Guard holds it and shows the 1,000 rows at stake. I press Cancel, and the rows stay safe.

To see the real thing in your own terminal, follow the try-it steps in the [main README](../README.md#try-it-with-the-demo-database).
