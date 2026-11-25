// Проверка JSON по схеме — подмножество JSON Schema, которым пользуются схемы проекта (config, api):
// type, enum, const, minimum, maximum, minLength, pattern, required, properties, additionalProperties, items, $ref, oneOf, nullable
const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value);

const matchesType = (value, type) => {
    const actual = typeOf(value);
    return [type].flat().some((expected) => expected === actual || (expected === 'number' && actual === 'integer'));
};

const resolve = (root, ref) => ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);

// Ошибки — по-русски с путём до поля: их видит человек в ответе API
export const validate = (schema, value, root = schema, path = '') => {
    const at = path || 'корень';
    if (value === null && schema.nullable) return [];
    if (schema.$ref) return validate(resolve(root, schema.$ref), value, root, path);
    if (schema.oneOf) {
        const passing = schema.oneOf.filter((option) => !validate(option, value, root, path).length);
        return passing.length === 1 ? [] : [`${at}: не подходит ни под один вариант`];
    }
    if (schema.type && !matchesType(value, schema.type)) return [`${at}: ожидается ${[schema.type].flat().join(' или ')}`];
    if ('const' in schema && value !== schema.const) return [`${at}: должно быть ${JSON.stringify(schema.const)}`];
    if (schema.enum && !schema.enum.includes(value)) return [`${at}: допустимо ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`];
    const errors = [];
    if (typeof value === 'number') {
        if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: не меньше ${schema.minimum}`);
        if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: не больше ${schema.maximum}`);
    }
    if (typeof value === 'string') {
        if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: не короче ${schema.minLength}`);
        if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: не подходит под шаблон ${schema.pattern}`);
    }
    if (Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...validate(schema.items, item, root, `${path}[${index}]`)));
    if (typeOf(value) === 'object') {
        for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path ? `${path}.` : ''}${key}: обязательное поле`);
        for (const [key, item] of Object.entries(value)) {
            const child = path ? `${path}.${key}` : key;
            if (schema.properties?.[key]) errors.push(...validate(schema.properties[key], item, root, child));
            else if (schema.additionalProperties === false) errors.push(`${child}: неизвестное поле`);
            else if (typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, item, root, child));
        }
    }
    return errors;
};
