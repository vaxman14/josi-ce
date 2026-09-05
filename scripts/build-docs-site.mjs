import fs from 'node:fs';

const template = fs.readFileSync('docs-site/template.html', 'utf8');
const body = fs.readFileSync('docs-site/body.html', 'utf8');
const headings = [...body.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
const toc = headings.map(([, id, title]) => `<a href="#${id}">${title.replace(/<[^>]+>/g, '')}</a>`).join('\n');
const page = template.replace('<!--TOC-->', toc).replace('<!--CONTENT-->', body);
fs.writeFileSync('docs-site/index.html', page);
