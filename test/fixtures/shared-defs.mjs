// A document schema like a rich-text MCP server's (zod, discriminated unions):
// five block types reach one shared inlineNode definition at different depths.
// The field report: narrowing inlineNode's marks enum was an error for paragraph
// and heading, and "review it" for the deeper four.
export function documentSchema(marks = ['bold', 'italic', 'code', 'strike']) {
  const ref = (name) => ({ $ref: `#/$defs/${name}` });
  const kind = (value) => ({ type: 'string', const: value });
  return {
    type: 'object',
    $defs: {
      inlineNode: {
        oneOf: [
          { type: 'object', properties: { type: kind('text'), text: { type: 'string' }, marks: { type: 'array', items: { type: 'string', enum: marks } } }, required: ['type', 'text'] },
          { type: 'object', properties: { type: kind('hashtag'), tag: { type: 'string' } }, required: ['type', 'tag'] },
        ],
      },
      paragraph: { type: 'object', properties: { type: kind('paragraph'), content: { type: 'array', items: ref('inlineNode') } }, required: ['type'] },
      listItem: { type: 'object', properties: { content: { type: 'array', items: ref('paragraph') } } },
      block: {
        oneOf: [
          ref('paragraph'),
          { type: 'object', properties: { type: kind('heading'), level: { type: 'integer' }, content: { type: 'array', items: ref('inlineNode') } }, required: ['type'] },
          { type: 'object', properties: { type: kind('bulletList'), items: { type: 'array', items: ref('listItem') } }, required: ['type'] },
          { type: 'object', properties: { type: kind('orderedList'), start: { type: 'integer' }, items: { type: 'array', items: ref('listItem') } }, required: ['type'] },
          { type: 'object', properties: { type: kind('table'), rows: { type: 'array', items: { type: 'object', properties: { cells: { type: 'array', items: { type: 'object', properties: { content: { type: 'array', items: ref('paragraph') } } } } } } } }, required: ['type'] },
          { type: 'object', properties: { type: kind('blockquote'), content: { type: 'array', items: ref('paragraph') } }, required: ['type'] },
        ],
      },
    },
    properties: { title: { type: 'string' }, blocks: { type: 'array', items: ref('block') } },
    required: ['blocks'],
  };
}
