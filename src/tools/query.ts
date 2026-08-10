/**
 * The generated query verbs return a union covering every shape the option
 * bag can produce: a number for `count: true`, a single entry for
 * `get: true`, and the list otherwise. None of our tools pass `count` or
 * `get`, so the list is the only shape the middleware can return — but the
 * options are runtime values the types cannot follow, so the narrowing has to
 * be stated rather than inferred.
 *
 * Extracting the array member of the union rather than casting to a named
 * type keeps the generated element types intact, so a field that stops
 * existing upstream still fails to compile.
 */
type ListOf<T> = Extract<T, readonly unknown[]>;

export function asList<T>(result: T): ListOf<T> {
  return result as ListOf<T>;
}
