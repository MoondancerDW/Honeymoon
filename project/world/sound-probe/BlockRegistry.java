import com.sun.tools.attach.VirtualMachine;
import java.io.PrintWriter;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.IdentityHashMap;
import java.util.Map;

public class BlockRegistry {
  public static void main(String[] args) throws Exception {
    VirtualMachine instance = VirtualMachine.attach(args[0]);
    try { instance.loadAgent(args[1], args[2]); } finally { instance.detach(); }
  }

  public static void agentmain(String output, Instrumentation instrumentation) throws Exception {
    Class<?> block = null;
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      if (type.getName().equals("amq")) { block = type; break; }
    }
    if (block == null) throw new IllegalStateException("block registry not initialized");
    Object[] blocks = (Object[]) block.getField("p").get(null);
    int[] opacity = (int[]) block.getField("r").get(null);
    int[] emission = (int[]) block.getField("t").get(null);
    boolean[] opaque = (boolean[]) block.getField("q").get(null);
    ClassLoader loader = block.getClassLoader();
    Class<?> material = loader.loadClass("agi");
    Class<?> sound = loader.loadClass("amu");
    Map<Object, String> materials = new IdentityHashMap<>();
    for (Field field : material.getFields()) {
      if (field.getType() == material && Modifier.isStatic(field.getModifiers())) materials.put(field.get(null), field.getName());
    }
    Field blockMaterial = block.getField("cB"), blockSound = block.getField("cz");
    Method blockName = block.getMethod("a");
    Method step = sound.getMethod("e"), place = sound.getMethod("b"), volume = sound.getMethod("c"), pitch = sound.getMethod("d");
    try (PrintWriter out = new PrintWriter(Files.newBufferedWriter(Paths.get(output), StandardCharsets.UTF_8))) {
      out.println("id\tname\topacity\temission\tmaterial\topaque\tstep\tplace\tvolume\tpitch\tclass");
      for (int id = 1; id < blocks.length; id++) {
        Object value = blocks[id];
        if (value == null) continue;
        Object audio = blockSound.get(value);
        out.printf(java.util.Locale.ROOT, "%d\t%s\t%d\t%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s%n",
          id, blockName.invoke(value), opacity[id], emission[id], materials.get(blockMaterial.get(value)),
          opaque[id], step.invoke(audio), place.invoke(audio), volume.invoke(audio), pitch.invoke(audio), value.getClass().getName());
      }
    }
    System.out.println("[honeymoon] Writing RedPower cover sound mappings");
    Class<?> covers = loader.loadClass("com.eloraam.redpower.core.CoverLib");
    Method getBlock = covers.getMethod("getBlock", int.class);
    Field blockId = block.getField("cm");
    try (PrintWriter out = new PrintWriter(Files.newBufferedWriter(Paths.get(output + ".covers"), StandardCharsets.UTF_8))) {
      for (int materialId = 0; materialId < 256; materialId++) {
        try {
          Object value = getBlock.invoke(null, materialId);
          if (value != null) out.println(materialId + "\t" + blockId.getInt(value));
        } catch (java.lang.reflect.InvocationTargetException missing) {
          if (!(missing.getCause() instanceof NullPointerException)) throw missing;
        }
      }
    }
  }
}
