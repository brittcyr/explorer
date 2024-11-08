import { manifest } from '@cks-systems/manifest-sdk';
import { TransactionError } from '@solana/web3.js';
import { Cluster } from '@utils/cluster';
import { getTransactionInstructionError } from '@utils/program-err';
import { getProgramName } from '@utils/tx';

export type LogMessage = {
    text: string;
    prefix: string;
    style: 'muted' | 'info' | 'success' | 'warning';
};

export type InstructionLogs = {
    invokedProgram: string | null;
    logs: LogMessage[];
    computeUnits: number;
    truncated: boolean;
    failed: boolean;
};

export function parseProgramLogs(logs: string[], error: TransactionError | null, cluster: Cluster): InstructionLogs[] {
    let depth = 0;
    const prettyLogs: InstructionLogs[] = [];
    function prefixBuilder(
        // Indent level starts at 1.
        indentLevel: number
    ) {
        let prefix;
        if (indentLevel <= 0) {
            console.warn(
                `Tried to build a prefix for a program log at indent level \`${indentLevel}\`. ` +
                    'Logs should only ever be built at indent level 1 or higher.'
            );
            prefix = '';
        } else {
            prefix = new Array(indentLevel - 1).fill('\u00A0\u00A0').join('');
        }
        return prefix + '> ';
    }

    let prettyError;
    if (error) {
        prettyError = getTransactionInstructionError(error);
    }

    const currentProgram: string[] = [];
    logs.forEach(log => {
        if (log.startsWith('Program log:')) {
            // Use passive tense
            log = log.replace(/Program log: (.*)/g, (match, p1) => {
                return `Program logged: "${p1}"`;
            });

            prettyLogs[prettyLogs.length - 1].logs.push({
                prefix: prefixBuilder(depth),
                style: 'muted',
                text: log,
            });
        } else if (log.startsWith('Log truncated')) {
            prettyLogs[prettyLogs.length - 1].truncated = true;
        } else {
            const regex = /Program (\w*) invoke \[(\d)\]/g;
            const matches = Array.from(log.matchAll(regex));

            if (matches.length > 0) {
                const programAddress = matches[0][1];
                currentProgram.push(programAddress);

                const programName = getProgramName(programAddress, cluster);

                if (depth === 0) {
                    prettyLogs.push({
                        computeUnits: 0,
                        failed: false,
                        invokedProgram: programAddress,
                        logs: [],
                        truncated: false,
                    });
                } else {
                    prettyLogs[prettyLogs.length - 1].logs.push({
                        prefix: prefixBuilder(depth),
                        style: 'info',
                        text: `Program invoked: ${programName}`,
                    });
                }

                depth++;
            } else if (log.includes('success')) {
                currentProgram.pop();
                prettyLogs[prettyLogs.length - 1].logs.push({
                    prefix: prefixBuilder(depth),
                    style: 'success',
                    text: `Program returned success`,
                });
                depth--;
            } else if (log.includes('failed')) {
                currentProgram.pop();
                const instructionLog = prettyLogs[prettyLogs.length - 1];
                instructionLog.failed = true;

                let currText = `Program returned error: "${log.slice(log.indexOf(': ') + 2)}"`;
                // failed to verify log of previous program so reset depth and print full log
                if (log.startsWith('failed')) {
                    depth++;
                    currText = log.charAt(0).toUpperCase() + log.slice(1);
                }

                instructionLog.logs.push({
                    prefix: prefixBuilder(depth),
                    style: 'warning',
                    text: currText,
                });
                depth--;
            } else {
                if (depth === 0) {
                    prettyLogs.push({
                        computeUnits: 0,
                        failed: false,
                        invokedProgram: null,
                        logs: [],
                        truncated: false,
                    });
                    depth++;
                }

                // Remove redundant program address from logs
                log = log.replace(/Program \w* consumed (\d*) (.*)/g, (match, p1, p2) => {
                    // Only aggregate compute units consumed from top-level tx instructions
                    // because they include inner ix compute units as well.
                    if (depth === 1) {
                        prettyLogs[prettyLogs.length - 1].computeUnits += Number.parseInt(p1);
                    }

                    return `Program consumed: ${p1} ${p2}`;
                });

                // native program logs don't start with "Program log:"
                prettyLogs[prettyLogs.length - 1].logs.push({
                    prefix: prefixBuilder(depth),
                    style: 'muted',
                    text: log,
                });

                if (log.includes("Program data: ") && currentProgram[currentProgram.length - 1] == "MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms") {
                    const data = log.substring("Program data: ".length);

                    const buffer: Buffer = Buffer.from(data, 'base64');
                    const fillLogPrefix: Uint8Array = Uint8Array.from([58, 230, 242, 3, 75, 113, 4, 169]);
                    const bufferPrefix: Uint8Array = Uint8Array.from(buffer.subarray(0, 8));
                    if (isEqualBytes(fillLogPrefix, bufferPrefix)) {
                        const deserializedFillLog: manifest.FillLog = manifest.FillLog.deserialize(
                            buffer.subarray(8),
                        )[0];
                        // TODO: Import convertU128 from manifest sdk, also
                        // factor in decimals to make human readable
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore
                        deserializedFillLog.price = Number(deserializedFillLog.price.inner);
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore
                        deserializedFillLog.baseAtoms = Number(deserializedFillLog.baseAtoms.inner);
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore
                        deserializedFillLog.quoteAtoms = Number(deserializedFillLog.quoteAtoms.inner);
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore
                        delete deserializedFillLog.padding;

                        prettyLogs[prettyLogs.length - 1].logs.push({
                            prefix: prefixBuilder(depth),
                            style: 'muted',
                            text: 'MFX Fill Log: \n' + JSON.stringify(deserializedFillLog.pretty(), null, 2),
                        });
                    }
                }
            }
        }
    });

    // If the instruction's simulation returned an error without any logs then add an empty log entry for Runtime error
    // For example BpfUpgradableLoader fails without returning any logs for Upgrade instruction with buffer that doesn't exist
    if (prettyError && prettyLogs.length === 0) {
        prettyLogs.push({
            computeUnits: 0,
            failed: true,
            invokedProgram: null,
            logs: [],
            truncated: false,
        });
    }

    if (prettyError && prettyError.index === prettyLogs.length - 1) {
        const failedIx = prettyLogs[prettyError.index];
        if (!failedIx.failed) {
            failedIx.failed = true;
            failedIx.logs.push({
                prefix: prefixBuilder(1),
                style: 'warning',
                text: `Runtime error: ${prettyError.message}`,
            });
        }
    }

    return prettyLogs;
}

export function isEqualBytes(
    bytes1: Uint8Array,
    bytes2: Uint8Array
): boolean {
    if (bytes1.length !== bytes2.length) {
        return false;
    }

    for (let i = 0; i < bytes1.length; i++) {
        if (bytes1[i] !== bytes2[i]) {
            return false;
        }
    }

    return true;
}