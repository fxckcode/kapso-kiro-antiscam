/**
 * Validacion CENTRALIZADA de limites configurables (PR04-F03).
 *
 * Varias funciones publicas aceptan un maximo por opciones (`maxReferences`,
 * `maxEntries`, `maxBytes`, `maxRedirects`, `timeoutMs`). Sin validacion, un
 * llamador podia pasar `NaN`, `Infinity`, un decimal, un negativo o un string
 * forzado en runtime y desactivar de hecho el limite: `length > NaN` es siempre
 * false, y `"10"` se compara lexicograficamente en algunos caminos.
 *
 * Regla unica: el valor debe ser un ENTERO de tipo `number` dentro de
 * `[min, max]`. Nunca se normaliza ni se recorta en silencio: un valor fuera de
 * rango se rechaza, porque recortarlo oculta el bug del llamador y da la falsa
 * impresion de haberse respetado.
 */

/**
 * true si `value` es un `number` entero dentro de `[min, max]`. Rechaza
 * `NaN`, `Infinity`, `-Infinity`, decimales y cualquier valor no numerico
 * (incluidos strings forzados en runtime). `Number.isInteger` ya excluye
 * `NaN` e infinitos.
 */
export function isBoundedInteger(value: unknown, min: number, max: number): boolean {
  if (typeof value !== "number") return false;
  if (!Number.isInteger(value)) return false;
  return value >= min && value <= max;
}

/**
 * Devuelve el limite validado o lanza `RangeError`. Se invoca ANTES de recorrer
 * entradas o producir resultados, de modo que un limite invalido no produzca
 * trabajo parcial.
 *
 * El mensaje nombra el campo y el rango permitido, nunca datos del usuario.
 */
export function assertBoundedInteger(
  value: unknown,
  min: number,
  max: number,
  context: string,
  field: string,
): number {
  if (!isBoundedInteger(value, min, max)) {
    throw new RangeError(
      `${context}: ${field} invalido; debe ser un entero entre ${min} y ${max}.`,
    );
  }
  return value as number;
}
