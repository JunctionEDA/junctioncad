// Bill of materials: the assembly's parts with their quantities, and the electronic parts of its boards.
import { defineAssemblyTool } from "../core/tool";
import { openBom } from "../panels/bom";

export default defineAssemblyTool({
  id: "bom", title: "Bill of materials", hint: "Parts and their quantities, with the boards' electronic parts; export as CSV", order: 80,
  icon: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 9h7M9 13h7M9 17h4"/>',
  run: (assembly) => openBom(assembly),
});
