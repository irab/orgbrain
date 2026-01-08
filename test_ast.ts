import * as ts from 'typescript';

const code = 'interface User { name: string; }';
const sourceFile = ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true);

function printNodes(node: ts.Node, indent = 0) {
  console.log('  '.repeat(indent) + ts.SyntaxKind[node.kind]);
  node.forEachChild(child => printNodes(child, indent + 1));
}

printNodes(sourceFile);
