import { extractFeatures, routeModel } from './src/core/model-router.js';

const f1 = extractFeatures('O que é TypeScript?', 0, false);
console.log('Test 1:', JSON.stringify(f1, null, 2));

const f2 = extractFeatures('O que é Python?', 0, false);
console.log('Test 2:', JSON.stringify(f2, null, 2));

const f3 = extractFeatures('Escreva uma function em Python', 0, false);
console.log('Test 3:', JSON.stringify(f3, null, 2));

const d1 = routeModel(f1);
console.log('Decision 1:', JSON.stringify(d1, null, 2));

const d2 = routeModel(f2);
console.log('Decision 2:', JSON.stringify(d2, null, 2));