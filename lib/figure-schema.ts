import { z } from "zod";

// What the tutor can draw with its pen besides words and marks. The tutor
// names the figure and its parts; the app draws it by hand, in time with the
// voice. No code from the model ever runs.

const label = z.string().nullable();

const Graph = z.object({
  kind: z.literal("graph"),
  x_min: z.number(),
  x_max: z.number(),
  y_min: z.number(),
  y_max: z.number(),
  x_label: label.describe("Axis name, such as \"x\" or \"t (s)\"."),
  y_label: label,
  curves: z
    .array(z.object({ formula: z.string().describe("In terms of x, such as \"x^2 - 2\", \"2sin(x)\", \"e^(-x/2)\"."), label }))
    .describe("Up to three curves."),
  points: z.array(z.object({ x: z.number(), y: z.number(), label })).describe("Marked points, such as an intercept or a vertex."),
});

const NumberLine = z.object({
  kind: z.literal("number_line"),
  from: z.number(),
  to: z.number(),
  marks: z.array(z.object({ at: z.number(), label, open: z.boolean().describe("An open circle, as for < or >.") })),
  jumps: z.array(z.object({ from: z.number(), to: z.number(), label })).describe("Hops drawn as arcs, such as +5 from -3 to 2."),
  shade_from: z.number().nullable().describe("Shade a range, as for an inequality's solution set."),
  shade_to: z.number().nullable(),
});

const Shape = z.object({
  kind: z.literal("shape"),
  vertices: z.array(z.object({ x: z.number(), y: z.number(), label })).describe("Corners in any units, y up, in order."),
  closed: z.boolean(),
  side_labels: z.array(label).describe("One per side, starting with the side from the first vertex to the second."),
  angle_labels: z.array(label).describe("One per vertex, written just inside the corner, such as \"90°\" or \"θ\"."),
});

const Flow = z.object({
  kind: z.literal("flow"),
  direction: z.enum(["right", "down"]),
  nodes: z.array(z.object({ text: z.string().describe("A few words.") })),
  arrows: z.array(z.object({ from: z.number().int(), to: z.number().int(), label })).describe("By node index, from 0."),
});

const Table = z.object({
  kind: z.literal("table"),
  header: z.boolean().describe("Whether the first row is a header."),
  rows: z.array(z.array(z.string())).describe("Short cells, such as a Punnett square or a truth table. Use \"?\" for cells the student fills in."),
});

const Forces = z.object({
  kind: z.literal("forces"),
  body: z.enum(["block", "point"]),
  incline_deg: z.number().nullable().describe("Slope angle if the block sits on a ramp, otherwise null."),
  forces: z.array(
    z.object({
      label: z.string(),
      angle_deg: z.number().describe("Direction: 0 is right, 90 is up, 180 is left, 270 is down."),
      size: z.number().describe("Relative length from 0.3 to 1."),
    }),
  ),
});

const Steps = z.object({
  kind: z.literal("steps"),
  lines: z
    .array(z.object({ math: z.string(), note: label.describe("What was done to get the next line, such as \"−5 both sides\".") }))
    .describe("Equation lines, written one under another and lined up on the equals sign."),
});

const Diagram = z.object({
  kind: z.literal("diagram"),
  title: label,
  nodes: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().describe("A few words."),
        row: z.number().int().describe("Grid row, 0 at the top."),
        col: z.number().int().describe("Grid column, 0 at the left."),
      }),
    )
    .describe("The parts (components of a method, model, system or argument) as boxes on a grid of up to 4 columns and 4 rows, one box per cell. A pipeline runs along a row, left to right; a stack runs down a column."),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label })).describe("Arrows between node ids, such as data flowing or one idea leading to another."),
  frames: z
    .array(z.object({ label: z.string(), nodes: z.array(z.string()) }))
    .describe("Named outlines around neighbouring nodes that belong together, such as \"Encoder\". Usually none."),
});

const Bars = z.object({
  kind: z.literal("bars"),
  title: label,
  unit: label.describe("Such as \"% accuracy\" or \"BLEU\"."),
  bars: z
    .array(z.object({ label: z.string(), value: z.number(), highlight: z.boolean().describe("Shade this bar, such as the paper's own method.") }))
    .describe("Up to eight numbers to compare, such as results from a table in the paper."),
});

const gridPt = z.array(z.number()).describe("[x, y] on the 100 by 100 grid, y down.");
const Sketch = z.object({
  kind: z.literal("sketch"),
  title: label,
  paths: z
    .array(
      z.object({
        points: z.array(z.array(z.number())).describe("[x, y] pairs on a 100 by 100 grid, y down. Three to forty points per path."),
        closed: z.boolean(),
        smooth: z.boolean().describe("true draws a flowing curve through the points (outlines, bodies, waves, organic shapes); false draws straight segments (objects, screens, axes)."),
      }),
    )
    .describe("A hand drawing of the thing itself, the kind a person doodles to explain: people talking, a cell, a neuron, a robot arm, a molecule, an experiment setup, points clustering in a space, a landscape with a ball rolling downhill. Up to twenty paths."),
  circles: z
    .array(z.object({ cx: z.number(), cy: z.number(), r: z.number(), filled: z.boolean() }))
    .describe("Circles on the same grid: heads, cells, nodes, data points (filled for small dots). Up to thirty."),
  arrows: z.array(z.object({ from: gridPt, to: gridPt })).describe("Arrows for motion, flow or influence inside the drawing. Up to eight."),
  labels: z
    .array(z.object({ x: z.number(), y: z.number(), text: z.string(), point_to: gridPt.nullable().describe("A part this label names; a short line is drawn from the label to it.") }))
    .describe("Short labels on the same grid, placed in clear space."),
});

// The things a scene can show. Each is drawn as a little picture by the app.
export const THINGS = [
  "person",
  "people",
  "robot",
  "document",
  "screen",
  "chat",
  "database",
  "gear",
  "idea",
  "magnifier",
  "warning",
  "check",
  "cross",
  "cloud",
  "globe",
  "chart",
  "clock",
  "brain",
  "network",
  "dots",
  "book",
  "money",
  "flask",
  "lock",
  "heart",
  "cycle",
  "eye",
  "target",
] as const;

const Scene = z.object({
  kind: z.literal("scene"),
  title: label,
  things: z
    .array(
      z.object({
        id: z.string(),
        what: z
          .enum(THINGS)
          .describe(
            "The picture: person; people (a group, drawn as `count` people: a few side by side, many as a crowd); robot (an AI, a model, an agent, a bot); document (a paper, a page, a prompt, a description, a post); screen (an app, a website, an interface, a prototype); chat (messages, posts and replies); database (data, a dataset); gear (a process, a method, an algorithm); idea; magnifier (search, inspection, analysis); warning (a risk, a harm, a failure); check; cross; cloud; globe (the world, society); chart (results, metrics); clock (time, speed); brain; network (connections, a social network, a graph); dots (data points, samples); book; money (cost); flask (an experiment); lock (security, privacy); heart; cycle (iterate, repeat); eye (looking, attention); target (a goal).",
          ),
        row: z.number().int().describe("Grid row, 0 at the top, up to 2."),
        col: z.number().int().describe("Grid column, 0 at the left, up to 3. One thing per cell."),
        count: z.number().int().nullable().describe("For people and dots: how many to draw, from 2 to 24, so a few look like a few and many like many. For document: 1 to 3 pages. Null otherwise."),
        caption: label.describe("What it is, in two to four words of the subject's own terms, written under it."),
        says: label.describe("A speech bubble from it: the few words it says or posts, or a symbol like \"!\" or \"?\". Null for none."),
      }),
    )
    .describe("Who and what is involved, each as a picture in its own cell of a grid of up to 4 columns and 3 rows. Things that act on each other go side by side along a row, left to right."),
  arrows: z.array(z.object({ from: z.string(), to: z.string(), label: label.describe("One or two words, such as \"writes\" or \"generates\".") })).describe("Arrows between thing ids: who makes, sends, becomes or causes what."),
  marks: z
    .array(z.object({ on: z.string().describe("The id of the thing to point out."), kind: z.enum(["circle", "cross", "check"]), note: label.describe("Two or three words written beside it, such as \"the problem\".") }))
    .describe("Pointing out a thing you are talking about: a circle around it, a cross over it, a tick beside it. Usually none or one."),
});

export const FigureSchema = z.union([Graph, NumberLine, Shape, Flow, Table, Forces, Steps, Diagram, Bars, Sketch, Scene]);
export type Figure = z.infer<typeof FigureSchema>;
