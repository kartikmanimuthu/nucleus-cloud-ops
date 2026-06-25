import { StateGraph, START, END } from "@langchain/langgraph";
import { TextToSQLAnnotation, type TextToSQLState } from "./state";
import { describeSchemaNode } from "./nodes/describe-schema";
import { generateSQLNode } from "./nodes/generate-sql";
import { executeSQLNode } from "./nodes/execute-sql";
import { reflectNode } from "./nodes/reflect";
import { synthesizeNode } from "./nodes/synthesize";

function shouldRetryOrSynthesize(state: TextToSQLState): "generate_sql" | "synthesize" {
    if (!state.satisfied && state.iteration < state.maxIterations) {
        return "generate_sql";
    }
    return "synthesize";
}

export function createTextToSQLGraph() {
    const workflow = new StateGraph(TextToSQLAnnotation)
        .addNode("describe_schema", describeSchemaNode)
        .addNode("generate_sql", generateSQLNode)
        .addNode("execute_sql", executeSQLNode)
        .addNode("reflect", reflectNode)
        .addNode("synthesize", synthesizeNode)
        .addEdge(START, "describe_schema")
        .addEdge("describe_schema", "generate_sql")
        .addEdge("generate_sql", "execute_sql")
        .addEdge("execute_sql", "reflect")
        .addConditionalEdges("reflect", shouldRetryOrSynthesize, {
            generate_sql: "generate_sql",
            synthesize: "synthesize",
        })
        .addEdge("synthesize", END);

    return workflow.compile();
}
