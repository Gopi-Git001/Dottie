export declare const PACKAGING_DIR: string;
export declare const NSIS_INCLUDE: string;
export declare const CLEANED_DIRS: string[];
export declare function checkPackaging(root?: string): Promise<string[]>;
export declare function smokeMarkersInMainBundle(root?: string, defineExpression?: string): Promise<string[]>;
export declare function minifiedSmokeMarkers(root?: string): Promise<string[]>;
export declare function productionSmokeProblems(root?: string): Promise<string[]>;
