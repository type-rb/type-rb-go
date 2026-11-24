import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const root = process.cwd();
const localRequire = createRequire(path.join(root, "package.json"));
let version;
try {
	({ version } = localRequire("typescript"));
} catch {
	throw new Error("TypeScript is not installed in this project; run trb install after adding it to devDependencies");
}
if (version !== request.typescriptVersion) {
	throw new Error("TypeRB native package indexing requires TypeScript " + request.typescriptVersion +
		"; found " + version + ". Set devDependencies.typescript to " + request.typescriptVersion + " and run trb install");
}
const ts = localRequire("typescript/unstable/async");

function symbolDeclaration(symbol) {
	return (symbol.valueDeclaration || symbol.declarations[0])?.resolve();
}

function wire(kind, name = "", args = [], nullable = false) {
	const result = { kind };
	if (name) result.name = name;
	if (args.length) result.args = args;
	if (nullable) result.nullable = true;
	return result;
}

function sameType(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function nullable(type, nativeNil) {
	return { ...type, nullable: true, ...(nativeNil ? { nativeNil } : {}) };
}

function containsNativeUndefined(type) {
	return type.nativeNil === "undefined" || type.nativeNil === "null_or_undefined" ||
		(type.args || []).some(containsNativeUndefined);
}

function sourceLooksReact(symbol) {
	return !!symbol?.declarations?.some((declaration) => /(?:@types[/\\]react|react[/\\])/.test(declaration.path));
}

function sourceLooksDOM(symbol) {
	return !!symbol?.declarations?.some((declaration) => /(?:^|[/\\])lib\.dom\.d\.ts$/.test(declaration.path));
}

async function reactType(type, checker) {
	const symbol = await type.getAliasSymbol() || await type.getSymbol();
	const name = symbol?.name || "";
	if (name === "ReactNode" && sourceLooksReact(symbol)) return wire("named", "ReactNode");
	if ((name === "Element" || name === "ReactElement") && sourceLooksReact(symbol)) return wire("named", "ReactNode");
	const text = await checker.typeToString(type);
	for (const eventName of ["MouseEvent", "ChangeEvent", "FormEvent", "KeyboardEvent", "SyntheticEvent"]) {
		if (text.startsWith(eventName + "<") || text.startsWith("React." + eventName + "<")) {
			return wire("named", eventName);
		}
	}
	return null;
}

async function browserType(type) {
	const symbol = await type.getAliasSymbol() || await type.getSymbol();
	const name = symbol?.name || "";
	if (name === "File" && sourceLooksDOM(symbol)) return wire("named", "File");
	return null;
}

async function portableType(type, state, depth = 0) {
	const { checker } = state;
	if (!type) return { error: "has no resolvable type" };
	if (depth > 12) return { error: "type nesting exceeds the native bridge limit" };
	const react = await reactType(type, state.checker);
	if (react) return { type: react };
	const browser = await browserType(type);
	if (browser) return { type: browser };
	if (type.flags & ts.TypeFlags.Any) return { error: "uses TypeScript any" };
	if (type.flags & ts.TypeFlags.Unknown) return { error: "uses TypeScript unknown" };
	if (type.flags & ts.TypeFlags.Never) return { error: "uses TypeScript never" };
	if (type.flags & ts.TypeFlags.Void) return { type: wire("void", "Void") };
	if (type.flags & ts.TypeFlags.StringLike) return { type: wire("string", "String") };
	if (type.flags & ts.TypeFlags.NumberLike) return { type: wire("float", "Float") };
	if (type.flags & ts.TypeFlags.BooleanLike) return { type: wire("bool", "Boolean") };
	if (type.flags & ts.TypeFlags.Null) return { type: { ...wire("nil", "Nil"), nativeNil: "null" } };
	if (type.flags & ts.TypeFlags.Undefined) return { type: { ...wire("nil", "Nil"), nativeNil: "undefined" } };
	if (type.isUnionType()) {
		let hasNull = false;
		let hasUndefined = false;
		const alternatives = [];
		for (const alternative of await type.getTypes()) {
			if (alternative.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) {
				hasNull ||= !!(alternative.flags & ts.TypeFlags.Null);
				hasUndefined ||= !!(alternative.flags & ts.TypeFlags.Undefined);
				continue;
			}
			if (alternative.flags & ts.TypeFlags.Never) continue;
			const converted = await portableType(alternative, state, depth + 1);
			if (converted.error) return converted;
			if (!alternatives.some((existing) => sameType(existing, converted.type))) alternatives.push(converted.type);
		}
		const nativeNil = hasUndefined ? (hasNull ? "null_or_undefined" : "undefined") : (hasNull ? "null" : "");
		if (alternatives.length === 0) return nativeNil ? { type: { ...wire("nil", "Nil"), nativeNil } } : { error: "contains no representable union alternative" };
		const result = alternatives.length === 1 ? alternatives[0] : wire("union", "Union", alternatives);
		return { type: nativeNil ? nullable(result, nativeNil) : result };
	}
	if (await checker.isArrayType(type)) {
		const typeArguments = await checker.getTypeArguments(type);
		if (typeArguments.length !== 1) return { error: "has an unsupported Array shape" };
		const element = await portableType(typeArguments[0], state, depth + 1);
		if (element.error) return element;
		if (containsNativeUndefined(element.type)) return { error: "uses undefined in an Array element; native element conversion is not supported" };
		return { type: wire("array", "Array", [element.type]) };
	}
	if (type.isTupleType()) return { error: "uses a TypeScript tuple" };
	const signatures = await checker.getSignaturesOfType(type, ts.SignatureKind.Call);
	if (signatures.length > 0) {
		if (signatures.length !== 1) return { error: "uses overloaded call signatures" };
		const signature = signatures[0];
		if (signature.typeParameters?.length) return { error: "uses generic call signatures" };
		const parameters = [];
		for (const parameter of await signature.getParameters()) {
			if (parameter.flags & ts.SymbolFlags.Optional) return { error: "uses optional callback parameters" };
			const declaration = await symbolDeclaration(parameter);
			if (declaration?.dotDotDotToken) return { error: "uses rest callback parameters" };
			const converted = await portableType(await checker.getTypeOfSymbolAtLocation(parameter, declaration || state.fallbackNode), state, depth + 1);
			if (converted.error) return converted;
			if (containsNativeUndefined(converted.type)) return { error: "uses undefined in a callback parameter; native callback conversion is not supported" };
			parameters.push(converted.type);
		}
		const returned = await portableType(await checker.getReturnTypeOfSignature(signature), state, depth + 1);
		if (returned.error) return returned;
		if (containsNativeUndefined(returned.type)) return { error: "uses undefined in a callback return; native callback conversion is not supported" };
		return { type: wire("function", "Function", [...parameters, returned.type]) };
	}
	return { error: "uses unsupported TypeScript type " + await checker.typeToString(type) };
}

async function recordFields(type, state) {
	const { checker } = state;
	const alternatives = type.isUnionType() ? (await type.getTypes()).filter((item) => !(item.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never))) : [type];
	const names = new Set();
	for (const alternative of alternatives) {
		for (const property of await checker.getPropertiesOfType(alternative)) names.add(property.name);
	}
	if (names.size > 512) return { error: "object exposes more than 512 properties" };
	const fields = [];
	const unsupportedFields = {};
	for (const name of [...names].sort()) {
		const convertedTypes = [];
		let optional = false;
		let issue = "";
		for (const alternative of alternatives) {
			const property = await checker.getPropertyOfType(alternative, name);
			if (!property) {
				optional = true;
				continue;
			}
			optional ||= !!(property.flags & ts.SymbolFlags.Optional);
			// The checker can resolve a mapped property even when it has no declaration.
			const propertyType = await checker.getTypeOfSymbol(property);
			if (!propertyType) {
				issue = "has no resolvable type";
				break;
			}
			const converted = await portableType(propertyType, state, 1);
			if (converted.error) {
				issue = converted.error;
				break;
			}
			if (!convertedTypes.some((existing) => sameType(existing, converted.type))) convertedTypes.push(converted.type);
		}
		if (issue || convertedTypes.length === 0) {
			unsupportedFields[name] = issue || "has no representable type";
			continue;
		}
		let fieldType = convertedTypes.length === 1 ? convertedTypes[0] : wire("union", "Union", convertedTypes);
		if (optional && !fieldType.nullable) fieldType = nullable(fieldType);
		fields.push({ name, type: fieldType, ...(optional ? { optional: true } : {}) });
	}
	return { fields, unsupportedFields };
}

async function isRenderable(type, checker) {
	if (!type) return false;
	if ((await reactType(type, checker))?.name === "ReactNode") return true;
	if (!type.isUnionType()) return false;
	for (const item of await type.getTypes()) {
		if (!(item.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) && !await isRenderable(item, checker)) return false;
	}
	return true;
}

function moduleSlug(name) {
	let result = "";
	for (const character of name) {
		result += /[A-Za-z0-9]/.test(character) ? character : "_" + character.codePointAt(0).toString(16) + "_";
	}
	return result || "Package";
}

async function componentExport(type, state, exportName) {
	const { checker } = state;
	let signature;
	for (const candidate of await checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
		if (await isRenderable(await checker.getReturnTypeOfSignature(candidate), checker)) {
			signature = candidate;
			break;
		}
	}
	if (!signature) {
		for (const candidate of await checker.getSignaturesOfType(type, ts.SignatureKind.Construct)) {
			const instance = await checker.getReturnTypeOfSignature(candidate);
			if (instance && await checker.getPropertyOfType(instance, "render")) {
				signature = candidate;
				break;
			}
		}
	}
	if (!signature) return null;
	const parameters = await signature.getParameters();
	if (parameters.length > 1) return { error: "React component has more than one props parameter" };
	if (parameters.length === 0) return { export: { kind: "component", type: wire("named", "ReactNode") } };
	const parameter = parameters[0];
	const declaration = await symbolDeclaration(parameter);
	const propsType = await checker.getTypeOfSymbolAtLocation(parameter, declaration || state.fallbackNode);
	const props = await recordFields(propsType, state);
	if (props.error) return props;
	const recordName = "Native_" + state.moduleSlug + "_" + exportName + "Props";
	state.records[recordName] = { kind: "record", type: wire("named", recordName), fields: props.fields, unsupportedFields: props.unsupportedFields };
	return {
		export: {
			kind: "component",
			type: wire("named", "ReactNode"),
			parameters: [wire("named", recordName)],
			required: 1,
			unsupportedFields: props.unsupportedFields,
		},
	};
}

async function ordinaryExport(type, state) {
	const { checker } = state;
	const signatures = await checker.getSignaturesOfType(type, ts.SignatureKind.Call);
	if (signatures.length !== 1) return { error: signatures.length > 1 ? "uses overloaded call signatures" : "is not a supported function or React component" };
	const signature = signatures[0];
	if (signature.typeParameters?.length) return { error: "uses generic call signatures" };
	const parameters = [];
	let required = 0;
	let variadic = false;
	for (const parameter of await signature.getParameters()) {
		const declaration = await symbolDeclaration(parameter);
		variadic ||= !!declaration?.dotDotDotToken;
		if (!(parameter.flags & ts.SymbolFlags.Optional) && !declaration?.questionToken && !declaration?.initializer && !declaration?.dotDotDotToken) required++;
		const converted = await portableType(await checker.getTypeOfSymbolAtLocation(parameter, declaration || state.fallbackNode), state, 0);
		if (converted.error) return { error: "parameter " + parameter.name + " " + converted.error };
		parameters.push(converted.type);
	}
	const returned = await portableType(await checker.getReturnTypeOfSignature(signature), state, 0);
	if (returned.error) return { error: "return type " + returned.error };
	return { export: { kind: "function", type: returned.type, parameters, required, ...(variadic ? { variadic: true } : {}) } };
}

async function indexModules(project, source) {
	const { checker } = project;
	const modules = {};
	for (const statement of source.statements) {
		const moduleName = statement.moduleSpecifier.text;
		const moduleSymbol = await checker.getSymbolAtLocation(statement.moduleSpecifier);
		if (!moduleSymbol) {
			modules[moduleName] = { exports: {}, unsupported: { "*": "TypeScript could not resolve this package" } };
			continue;
		}
		const state = { checker, records: {}, moduleSlug: moduleSlug(moduleName), fallbackNode: source };
		const exports = {};
		const unsupported = {};
		const symbols = await checker.getExportsOfModule(moduleSymbol);
		for (const original of [...symbols].sort((left, right) => left.name.localeCompare(right.name))) {
			const exportName = original.name;
			if (exportName === "default") {
				unsupported[exportName] = "uses a default export; automatic indexing supports named exports only";
				continue;
			}
			const symbol = original.flags & ts.SymbolFlags.Alias ? await checker.getAliasedSymbol(original) : original;
			const type = await checker.getTypeOfSymbol(symbol);
			if (!type) {
				unsupported[exportName] = "has no resolvable value type";
				continue;
			}
			const component = await componentExport(type, state, exportName);
			const converted = component || await ordinaryExport(type, state);
			if (converted.error) unsupported[exportName] = converted.error;
			else exports[exportName] = converted.export;
		}
		modules[moduleName] = { exports, ...(Object.keys(state.records).length ? { records: state.records } : {}), ...(Object.keys(unsupported).length ? { unsupported } : {}) };
	}
	return modules;
}

// Resolve package exports with TypeScript's bundler resolver in the project's
// own directory. The config and imports exist only in this compiler session.
const config = path.join(root, "__trb_native_types__.json");
const entry = path.join(root, "__trb_native_types__.tsx");
const options = { target: "esnext", module: "esnext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, allowJs: true };
const files = new Map([
	[config, JSON.stringify({ compilerOptions: options, files: [entry] })],
	[entry, request.modules.map(name => "import " + JSON.stringify(name) + ";").join("\n")],
]);
const api = new ts.API({ cwd: root, fs: {
	readFile: name => files.get(path.normalize(name)),
	fileExists: name => files.has(path.normalize(name)) || undefined,
} });
try {
	const snapshot = await api.updateSnapshot({ openProjects: [config] });
	const project = snapshot.getProject(config);
	const source = await project.program.getSourceFile(entry);
	const modules = await indexModules(project, source);
	process.stdout.write(JSON.stringify({ typescriptVersion: version, modules }));
} finally {
	await api.close();
}
