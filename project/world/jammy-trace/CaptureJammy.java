import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.StringJoiner;
import org.lwjgl.opengl.GL11;

public final class CaptureJammy {
    private static final String ROOT = "net.minecraft.jammy780.furniture.";

    // Block/tile associations in JammyFurnitureModCore, and bindings in jfm_ClientProxy.
    private static final String[][] REGISTRY = {
        {"wood_one", "wood.jfm_WoodBlocksOne", "WoodBlocks", "WoodBlocksRendererOne"},
        {"wood_two", "wood.jfm_WoodBlocksTwo", "WoodBlocksTwo", "WoodBlocksRendererTwo"},
        {"wood_three", "wood.jfm_WoodBlocksThree", "WoodBlocksThree", "WoodBlocksRendererThree"},
        {"bath", "jfm_BathBlock", "Bath", "BathRenderer"},
        {"iron_one", "iron.jfm_IronBlocksOne", "IronBlocksOne", "IronBlocksRendererOne"},
        {"iron_two", "iron.jfm_IronBlocksTwo", "IronBlocksTwo", "IronBlocksRendererTwo"},
        {"ceramic_one", "ceramic.jfm_CeramicBlocksOne", "CeramicBlocksOne", "CeramicBlocksRendererOne"},
        {"roofing_one", "roofing.jfm_RoofingBlocksOne", "RoofingBlocksOne", "RoofingBlocksRendererOne"},
        {"mob_heads_one", "heads.jfm_MobHeadsOne", "MobHeadsOne", "MobHeadsOneRenderer"},
        {"mob_heads_two", "heads.jfm_MobHeadsTwo", "MobHeadsTwo", "MobHeadsTwoRenderer"},
        {"mob_heads_three", "heads.jfm_MobHeadsThree", "MobHeadsThree", "MobHeadsThreeRenderer"},
        {"mob_heads_four", "heads.jfm_MobHeadsFour", "MobHeadsFour", "MobHeadsFourRenderer"},
        {"arm_chair", "sofa.jfm_BlockArmChair", "ArmChair", "ArmChairRenderer"},
        {"sofa_left", "sofa.jfm_BlockSofaLeft", "SofaLeft", "SofaLeftRenderer"},
        {"sofa_right", "sofa.jfm_BlockSofaRight", "SofaRight", "SofaRightRenderer"},
        {"sofa_center", "sofa.jfm_BlockSofaCenter", "SofaCenter", "SofaCenterRenderer"},
        {"sofa_corner", "sofa.jfm_BlockSofaCorner", "SofaCorner", "SofaCornerRenderer"},
        {"misc_one", "jfm_BlockMiscOne", "MiscOne", "MiscOneRenderer"},
        {"lights_on", "jfm_BlockLightsOn", "LightsOn", "LightsRenderer"},
        {"lights_off", "jfm_BlockLightsOn", "LightsOn", "LightsRenderer"},
    };

    public static void main(String[] arguments) throws Exception {
        if (arguments.length != REGISTRY.length) throw new IllegalArgumentException("Expected Jammy config block IDs");
        for (String[] entry : REGISTRY) {
            int id = readId(entry[0], arguments);
            Class<?> tileType = Class.forName(ROOT + "tiles.jfm_TileEntity" + entry[2]);
            Class<?> rendererType = Class.forName(ROOT + "render.jfm_" + entry[3]);
            Class<?> blockType = Class.forName(ROOT + "blocks." + entry[1]);
            any tile = (any) tileType.getDeclaredConstructor().newInstance();
            tile.k = new yc();
            tile.k.blockId = id;
            bdx renderer = (bdx) rendererType.getDeclaredConstructor().newInstance();
            amq block = createBlock(entry[0], id, blockType, tileType);
            for (int metadata = 0; metadata < 16; metadata++) {
                tile.k.metadata = metadata;
                System.out.println("model\t" + id + "\t" + metadata + "\t" + entry[3]);
                GL11.begin((texture, positions, uv) -> System.out.println("quad\t" + texture
                    + "\t" + numericArray(positions) + "\t" + numericArray(uv)));
                renderer.a(tile, 0, 0, 0, 0);
                GL11.end();

                List<aoe> collisions = new ArrayList<>();
                block.a(tile.k, 0, 0, 0, aoe.a(-16, -16, -16, 16, 16, 16), collisions, null);
                for (aoe box : collisions) printBox("collision", box);
                block.a(tile.k, 0, 0, 0);
                printBox("selection", block.b_(tile.k, 0, 0, 0));
                boolean animatedDoor = (entry[0].equals("iron_one") && metadata < 8)
                    || (entry[0].equals("iron_two") && metadata < 4);
                if (animatedDoor) {
                    Field lidAngle = tileType.getField("lidAngle");
                    Field previousLidAngle = tileType.getField("prevLidAngle");
                    lidAngle.setFloat(tile, 1.0f);
                    previousLidAngle.setFloat(tile, 1.0f);
                    System.out.println("open\t" + id + "\t" + metadata);
                    GL11.begin((texture, positions, uv) -> System.out.println("quad\t" + texture
                        + "\t" + numericArray(positions) + "\t" + numericArray(uv)));
                    renderer.a(tile, 0, 0, 0, 0);
                    GL11.end();
                    lidAngle.setFloat(tile, 0.0f);
                    previousLidAngle.setFloat(tile, 0.0f);
                }
            }
        }
    }

    private static void printBox(String type, aoe box) {
        if (box != null) System.out.println(type + "\t" + numericArray(new double[]{box.a, box.b, box.c, box.d, box.e, box.f}));
    }

    private static amq createBlock(String name, int id, Class<?> block, Class<?> tile) throws Exception {
        if (name.startsWith("lights_")) {
            Constructor<?> constructor = block.getConstructor(int.class, int.class, Class.class, boolean.class);
            return (amq) constructor.newInstance(id, 0, tile, name.equals("lights_on"));
        }
        return (amq) block.getConstructor(int.class, int.class, Class.class).newInstance(id, 0, tile);
    }

    private static int readId(String name, String[] arguments) {
        String prefix = name + "=";
        for (String argument : arguments) {
            if (argument.startsWith(prefix)) return Integer.parseInt(argument.substring(prefix.length()));
        }
        throw new IllegalArgumentException("Missing config value for " + name);
    }

    private static String numericArray(double[] values) {
        StringJoiner joined = new StringJoiner(",");
        for (double value : values) joined.add(Double.toString(value));
        return joined.toString();
    }
}
