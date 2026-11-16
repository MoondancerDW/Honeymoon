import java.io.PrintWriter;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.Properties;
import java.util.HashSet;
import java.util.Set;

public final class CreativeRegistryProbe {
  private static final class State {
    String name = "";
    String nameKey = "";
    boolean creative;
  }

  public static void premain(final String output, final Instrumentation instrumentation) {
    Thread worker = new Thread(() -> {
      try {
        for (int attempt = 0; attempt < 1200; attempt++) {
          for (Class<?> type : instrumentation.getAllLoadedClasses()) {
            if (!type.getName().equals("cpw.mods.fml.common.Loader")) continue;
            ClassLoader loader = type.getClassLoader();
            Class<?> lifecycle = loader.loadClass("cpw.mods.fml.common.LoaderState");
            Object instance = type.getMethod("instance").invoke(null);
            if (instance != null && Boolean.TRUE.equals(type.getMethod("hasReachedState", lifecycle)
                .invoke(instance, lifecycle.getField("AVAILABLE").get(null)))) {
              // FML reaches AVAILABLE just before it recomputes the active language table.
              Thread.sleep(1800);
              capture(loader, output);
              System.exit(0);
            }
          }
          Thread.sleep(100);
        }
        throw new IllegalStateException("Forge did not reach AVAILABLE before the deadline");
      } catch (Throwable problem) {
        problem.printStackTrace();
        System.exit(1);
      }
    }, "Honeymoon creative registry");
    worker.setDaemon(true);
    worker.start();
  }

  private static Object safe(Method method, Object receiver, Object... args) {
    try { return method.invoke(receiver, args); }
    catch (ReflectiveOperationException | RuntimeException problem) { return null; }
  }

  private static Method optional(Class<?> type, String name, Class<?>... arguments) {
    try { return type.getMethod(name, arguments); }
    catch (NoSuchMethodException missing) { return null; }
  }

  private static String iconResource(Object icon, Method name) {
    try {
      Object resource = icon.getClass().getField("resourceLocation").get(icon);
      if (resource != null) return column(resource);
    } catch (ReflectiveOperationException ignored) {
      // Some variants use a texture icon directly without a resource field.
    }
    return name == null ? "" : column(safe(name, icon));
  }

  private static Object indexedIcon(ClassLoader loader, Object texture, Object index) {
    if (texture == null || !texture.toString().startsWith("atlas_") || !(index instanceof Integer)) return null;
    try {
      Class<?> registry = loader.loadClass("net.fybertech.chiselretro.IconRegister");
      Object atlas = registry.getMethod("getRegister", String.class).invoke(null, texture.toString());
      if (atlas != null) return ((Map<?, ?>) registry.getField("idToIcon").get(atlas)).get(index);
    } catch (ReflectiveOperationException ignored) {
      // 16x16 legacy sheets do not have a Chisel icon registry.
    }
    return null;
  }

  private static String column(Object value) {
    return value == null ? "" : String.valueOf(value).replace('\t', ' ').replace('\n', ' ').replace('\r', ' ');
  }

  private static void row(PrintWriter out, Object... values) {
    for (int i = 0; i < values.length; i++) {
      if (i > 0) out.print('\t');
      out.print(column(values[i]));
    }
    out.println();
  }

  private static void captureFlatItems(ClassLoader loader, String output, Object[] items,
      Properties english, Properties russian) throws Exception {
    Class<?> item = loader.loadClass("up"), stack = loader.loadClass("ur"), tab = loader.loadClass("tj");
    Class<?> itemBlock = loader.loadClass("vq");
    Field stackId = stack.getField("c");
    Method damage = stack.getMethod("j"), stackKey = item.getMethod("i", stack);
    Method itemTab = item.getMethod("w"), itemTabs = item.getMethod("getCreativeTabs");
    Method subtypes = item.getMethod("a", int.class, tab, List.class);
    Method texture = item.getMethod("getTextureFile");
    Method passCount = item.getMethod("getRenderPasses", int.class);
    Method icon = item.getMethod("getIconIndex", stack, int.class);
    Method color = item.getMethod("a", stack, int.class);
    try (PrintWriter out = new PrintWriter(Files.newBufferedWriter(Paths.get(output + ".flat"), StandardCharsets.UTF_8))) {
      row(out, "id", "damage", "nameEn", "nameRu", "textureFile", "passes", "class");
      for (int id = 1; id < items.length; id++) {
        Object value = items[id];
        if (value == null || itemBlock.isInstance(value)) continue;
        List<Object> variants = new ArrayList<>();
        Object mainTab = safe(itemTab, value);
        safe(subtypes, value, id, mainTab, variants);
        Object[] tabs = (Object[]) safe(itemTabs, value);
        if (tabs != null) for (Object other : tabs) {
          if (other != null && other != mainTab) safe(subtypes, value, id, other, variants);
        }
        if (variants.isEmpty()) variants.add(stack.getConstructor(int.class, int.class, int.class).newInstance(id, 1, 0));
        Set<Integer> emitted = new HashSet<>();
        for (Object variant : variants) {
          if (variant == null || stackId.getInt(variant) != id) continue;
          int metadata = (Integer) damage.invoke(variant);
          if (!emitted.add(metadata)) continue;
          String key = column(safe(stackKey, value, variant)) + ".name";
          String name = english.getProperty(key);
          String text = russian.getProperty(key);
          Object count = safe(passCount, value, metadata);
          List<String> passes = new ArrayList<>();
          for (int pass = 0; pass < (count instanceof Integer ? (Integer) count : 1); pass++) {
            Object index = safe(icon, value, variant, pass);
            if (!(index instanceof Integer) || (Integer) index < 0) continue;
            Object tint = safe(color, value, variant, pass);
            passes.add(index + ":" + (tint instanceof Integer ? (Integer) tint & 0xFFFFFF : 0xFFFFFF));
          }
          if (!passes.isEmpty()) row(out, id, metadata, name == null ? key : name,
            text == null ? name : text, safe(texture, value), String.join(",", passes), value.getClass().getName());
        }
      }
      if (out.checkError()) throw new IllegalStateException("Failed to write the flat item registry");
    }
  }

  private static void capture(ClassLoader loader, String output) throws Exception {
    Class<?> block = loader.loadClass("amq"), item = loader.loadClass("up"), stack = loader.loadClass("ur");
    Class<?> tab = loader.loadClass("tj"), material = loader.loadClass("agi");
    Object[] blocks = (Object[]) block.getField("p").get(null), items = (Object[]) item.getField("e").get(null);
    int[] light = (int[]) block.getField("t").get(null), opacity = (int[]) block.getField("r").get(null);
    Field blockMaterial = block.getField("cB"), stackId = stack.getField("c");
    Method blockName = block.getMethod("a"), translation = block.getMethod("B"), texture = block.getMethod("getTextureFile");
    Method subtype = block.getMethod("a", int.class, tab, List.class), tabOf = block.getMethod("E");
    Method stackName = stack.getMethod("r"), damage = stack.getMethod("j"), stackKey = item.getMethod("i", stack);
    Method itemSubtypes = item.getMethod("a", int.class, tab, List.class), itemTabOf = item.getMethod("w");
    Method itemTabs = item.getMethod("getCreativeTabs");
    Method textureAt = block.getMethod("a", int.class, int.class), renderType = block.getMethod("d");
    Method isOpaque = block.getMethod("c"), normal = block.getMethod("b"), tabName = tab.getMethod("b");
    Method entity = block.getMethod("hasTileEntity", int.class), itemBounds = block.getMethod("f");
    Method renderPass = block.getMethod("n"), color = block.getMethod("g_", int.class);
    Method blocked = material.getMethod("c"), fluid = material.getMethod("d");
    Method[] box = new Method[6];
    String[] getters = {"v", "w", "x", "y", "z", "A"};
    for (int i = 0; i < box.length; i++) box[i] = block.getMethod(getters[i]);

    Class<?> strings = loader.loadClass("bn");
    Class<?> translations = loader.loadClass("cpw.mods.fml.common.registry.LanguageRegistry");
    Method loadLanguage = translations.getMethod("loadLanguageTable", Properties.class, String.class);
    Object registry = translations.getMethod("instance").invoke(null);
    Properties english = (Properties) strings.getField("b").get(strings.getConstructor(String.class).newInstance("en_US"));
    Properties russian = (Properties) strings.getField("b").get(strings.getConstructor(String.class).newInstance("ru_RU"));
    loadLanguage.invoke(registry, english, "en_US");
    loadLanguage.invoke(registry, russian, "ru_RU");
    Class<?> covers = loader.loadClass("com.eloraam.redpower.core.CoverLib");
    Method coverData = covers.getMethod("damageToCoverData", int.class), coverValue = covers.getMethod("damageToCoverValue", int.class);
    Method coverName = covers.getMethod("getName", int.class);

    captureFlatItems(loader, output, items, english, russian);
    try (PrintWriter out = new PrintWriter(Files.newBufferedWriter(Paths.get(output), StandardCharsets.UTF_8));
         PrintWriter inventory = new PrintWriter(Files.newBufferedWriter(Paths.get(output + ".items"), StandardCharsets.UTF_8))) {
      row(out, "id", "meta", "creative", "stackName", "stackKey", "blockName", "translation", "class", "tab",
          "textureFile", "faces", "renderType", "opaque", "normal", "bounds", "materialBlocks", "materialLiquid",
          "tileEntity", "opacity", "emission", "pass", "icons", "color", "nameEn", "nameRu");
      row(inventory, "id", "damage", "name", "stackKey", "nameEn", "nameRu", "creative", "coverData", "coverValue");
      for (int id = 1; id < blocks.length; id++) {
        Object value = blocks[id];
        if (value == null) continue;
        Object itemValue = items[id];
        Object creativeTab = safe(tabOf, value);
        if (creativeTab == null && itemValue != null) creativeTab = safe(itemTabOf, itemValue);
        List<Object> creativeStacks = new ArrayList<>();
        if (itemValue != null) safe(itemSubtypes, itemValue, id, creativeTab, creativeStacks);
        Object[] tabs = itemValue == null ? null : (Object[]) safe(itemTabs, itemValue);
        if (tabs != null) for (Object extraTab : tabs) {
          if (extraTab != null && extraTab != creativeTab) safe(itemSubtypes, itemValue, id, extraTab, creativeStacks);
        }
        if (itemValue != null) safe(subtype, value, id, creativeTab, creativeStacks);
        if (itemValue != null && creativeStacks.stream().noneMatch(itemStack -> itemStack != null)) {
          creativeStacks.add(stack.getConstructor(int.class, int.class, int.class).newInstance(id, 1, 0));
        }
        Set<Integer> tabDamages = new HashSet<>();
        for (Object itemStack : creativeStacks) if (itemStack != null && stackId.getInt(itemStack) == id) {
          tabDamages.add((Integer) damage.invoke(itemStack));
        }
        // Every legal CoverLib material and shape is available from the material picker.
        if (id == 750 && itemValue != null) {
          for (int materialId = 0; materialId < 256; materialId++) {
            if (safe(coverName, null, materialId) == null) continue;
            for (int kind = 0; kind <= 45; kind++) {
              if (kind > 0 && kind < 16) continue;
              int data = kind << 8 | materialId;
              creativeStacks.add(stack.getConstructor(int.class, int.class, int.class).newInstance(id, 1, data));
            }
          }
        }
        TreeMap<Integer, State> states = new TreeMap<>();
        TreeMap<Integer, State> stackStates = new TreeMap<>();
        for (Object itemStack : creativeStacks) {
          if (itemStack == null || stackId.getInt(itemStack) != id) continue;
          int meta = (Integer) damage.invoke(itemStack);
          State state = new State();
          state.name = column(safe(stackName, itemStack));
          state.nameKey = column(safe(stackKey, itemValue, itemStack));
          state.creative = (creativeTab != null || tabs != null && tabs.length > 0) && tabDamages.contains(meta);
          if (meta >= 0 && meta < 16) states.put(meta, state);
          stackStates.put(meta, state);
        }
        for (Map.Entry<Integer, State> entry : stackStates.entrySet()) {
          State state = entry.getValue();
          row(inventory, id, entry.getKey(), state.name, state.nameKey, english.getProperty(state.nameKey + ".name"),
              russian.getProperty(state.nameKey + ".name"), state.creative,
              id == 750 ? safe(coverData, null, entry.getKey()) : null, id == 750 ? safe(coverValue, null, entry.getKey()) : null);
        }
        for (int meta = 0; meta < 16; meta++) states.putIfAbsent(meta, new State());
        String className = value.getClass().getName();
        Method getIcon = optional(value.getClass(), "getIcon", int.class, int.class);
        Method getIconName = getIcon == null ? null : optional(getIcon.getReturnType(), "getIconName");
        safe(itemBounds, value);
        StringBuilder bounds = new StringBuilder();
        for (Method getter : box) { if (bounds.length() > 0) bounds.append(','); bounds.append(safe(getter, value)); }
        Object substance = blockMaterial.get(value);
        Object textureFile = safe(texture, value);
        for (Map.Entry<Integer, State> entry : states.entrySet()) {
          int meta = entry.getKey();
          State state = entry.getValue();
          StringBuilder faces = new StringBuilder();
          StringBuilder icons = new StringBuilder();
          for (int side = 0; side < 6; side++) {
            if (side > 0) { faces.append(','); icons.append(','); }
            Object index = safe(textureAt, value, side, meta);
            faces.append(index);
            Object icon = getIconName == null ? null : safe(getIcon, value, side, meta);
            if (icon == null) icon = indexedIcon(loader, textureFile, index);
            if (icon != null) icons.append(iconResource(icon, getIconName == null ? optional(icon.getClass(), "getIconName") : getIconName));
          }
          Object blockKey = safe(blockName, value);
          String nameKey = !state.nameKey.isEmpty() ? state.nameKey + ".name" : blockKey != null ? blockKey + ".name" : "";
          row(out, id, meta, state.creative, state.name, state.nameKey, blockKey, safe(translation, value),
              className, creativeTab == null ? null : safe(tabName, creativeTab), textureFile, faces,
              safe(renderType, value), safe(isOpaque, value), safe(normal, value), bounds,
              safe(blocked, substance), safe(fluid, substance), safe(entity, value, meta), opacity[id], light[id],
              safe(renderPass, value), icons, safe(color, value, meta), english.getProperty(nameKey), russian.getProperty(nameKey));
        }
      }
      if (out.checkError() || inventory.checkError()) throw new IllegalStateException("Failed to write the creative registry");
    }
    System.out.println("[creative] Wrote the Forge registry to " + output);
  }
}
