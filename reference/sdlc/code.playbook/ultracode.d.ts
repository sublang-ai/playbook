/** Whether the adapter supports independent Ultracode tuning. */
export declare function isUltracodeSupported(adapter: string): boolean;
/** Validate the authored boolean and project only supported fields to Cligent. */
export declare function ultracodeForCall(adapter: string, value: unknown, path: string): {
    ultracode?: boolean;
};
