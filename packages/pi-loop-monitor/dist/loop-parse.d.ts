export declare function isValidCronExpression(expr: string): boolean;
export declare function parseInterval(input: string): {
    cron: string;
    description: string;
};
export declare function cronToNextFire(cronExpr: string, fromDate?: Date): Date;
export declare function computeJitter(taskId: string, recurring: boolean, scheduleMinutes: number): number;
