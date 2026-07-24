declare module "papaparse" {
  export interface ParseResult<T> {
    data: T[];
    errors: Array<{ type: string; code: string; message: string; row?: number }>;
    meta: { fields?: string[]; delimiter: string; linebreak: string; truncated: boolean };
  }

  export interface ParseConfig<T = unknown> {
    header?: boolean;
    skipEmptyLines?: boolean | "greedy";
    transformHeader?: (header: string, index: number) => string;
    transform?: (value: string, field: string | number) => unknown;
    complete?: (results: ParseResult<T>) => void;
    error?: (error: Error) => void;
    [key: string]: unknown;
  }

  export function parse<T = unknown>(input: string | File, config?: ParseConfig<T>): void;

  const Papa: { parse: typeof parse };
  export default Papa;
}
