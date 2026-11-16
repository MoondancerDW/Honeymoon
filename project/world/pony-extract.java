import java.lang.reflect.Field;
import java.util.List;

/** Reads model quads and pivots from the original client without starting Minecraft. */
final class PonyExtract {
    private static final Field BOX_FACES = field(aya.class, "i");
    private static final Field PLANE_FACES = field(PlaneRenderer.class, "faces");

    private static Field field(Class<?> type, String name) {
        try {
            Field field = type.getDeclaredField(name);
            field.setAccessible(true);
            return field;
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void quad(axd face) {
        StringBuilder line = new StringBuilder("quad");
        for (axq vertex : face.a) {
            line.append('\t').append(vertex.a.c).append('\t').append(vertex.a.d)
                .append('\t').append(vertex.a.e).append('\t').append(vertex.b).append('\t').append(vertex.c);
        }
        System.out.println(line);
    }

    private static void renderer(String name, Object renderer) throws ReflectiveOperationException {
        if (renderer instanceof ayf) {
            ayf box = (ayf) renderer;
            if (box.k || !box.j || box.l.isEmpty()) return;
            if (box.o != 0 || box.p != 0 || box.q != 0 || (box.m != null && !box.m.isEmpty())) {
                throw new IllegalStateException("Unexpected nested or offset pony box: " + name);
            }
            pose(name, box.c, box.d, box.e, box.f, box.g, box.h);
            for (Object modelBox : (List<?>) box.l) {
                for (axd face : (axd[]) BOX_FACES.get(modelBox)) quad(face);
            }
        } else {
            PlaneRenderer plane = (PlaneRenderer) renderer;
            axd[] faces = (axd[]) PLANE_FACES.get(plane);
            if (faces == null) return;
            pose(name, plane.rotationPointX, plane.rotationPointY, plane.rotationPointZ,
                plane.rotateAngleX, plane.rotateAngleY, plane.rotateAngleZ);
            for (axd face : faces) quad(face);
        }
    }

    private static void pose(String name, float... values) {
        StringBuilder line = new StringBuilder("part\t").append(name);
        for (float value : values) line.append('\t').append(value);
        System.out.println(line);
    }

    private static void renderers(String name, Object[] renderers) throws ReflectiveOperationException {
        for (int i = 0; i < renderers.length; i++) renderer(name + "." + i, renderers[i]);
    }

    private static void fillUnusedPlanes(pm_newPonyAdv pony, PlaneRenderer[] planes) {
        for (int i = 0; i < planes.length; i++) {
            if (planes[i] == null) planes[i] = new PlaneRenderer(pony, 0, 0);
        }
    }

    private static void capture(boolean advanced) throws ReflectiveOperationException {
        pm_newPonyAdv pony = advanced ? new pm_newPonyAdv("") : new pm_newPony("");
        pony.init();
        // The basic model leaves some inherited advanced slots empty.
        fillUnusedPlanes(pony, pony.Bodypiece);
        fillUnusedPlanes(pony, pony.LeftPlotPiece);
        fillUnusedPlanes(pony, pony.RightPlotPiece);
        pony.isPegasus = true;
        pony.size = 1;
        pony.p = -9999;
        pony.animate(new AniParams(0, 0, 0, 0, 0));
        System.out.println("model\t" + (advanced ? "advanced" : "basic"));
        renderer("head", pony.head);
        renderers("headpiece", pony.headpiece);
        renderer("helmet", pony.helmet);
        renderers("mane", pony.Mane);
        renderers("mohawk", pony.Irokeeze);
        renderers("maneRight", pony.RightExtMane);
        renderers("maneLeft", pony.LeftExtMane);
        renderers("muzzleFemale", pony.MuzzleFemale);
        pony.isMale = true;
        pony.animate(new AniParams(0, 0, 0, 0, 0));
        renderers("muzzleMale", pony.MuzzleMale);
        renderer("body", pony.Body);
        renderers("body", pony.Bodypiece);
        renderers("neck", pony.BodypieceNeck);
        renderers("hipLeft", pony.LeftPlotPiece);
        renderers("hipRight", pony.RightPlotPiece);
        renderer("frontRight", pony.RightArm);
        renderer("frontLeft", pony.LeftArm);
        renderer("hindRight", pony.RightLeg);
        renderer("hindRight.joint", pony.RightLegJoint);
        renderers("hindRight", pony.RightSubLeg);
        renderer("hindLeft", pony.LeftLeg);
        renderer("hindLeft.joint", pony.LeftLegJoint);
        renderers("hindLeft", pony.LeftSubLeg);
        renderers("tail", pony.Tail);
        renderers("wingLeft", pony.LeftWing);
        renderers("wingRight", pony.RightWing);
        pony.isFlying = true;
        pony.animate(new AniParams(0, 0, 0, 0, 0));
        renderers("wingLeftOpen", pony.LeftWingExt);
        renderers("wingRightOpen", pony.RightWingExt);
    }

    private static void captureArmor() throws ReflectiveOperationException {
        pm_newPonyArmor pony = new pm_newPonyArmor("");
        pony.init(0f,.55f);
        pony.p = -9999;
        pony.animate(new AniParams(0, 0, 0, 0, 0));
        System.out.println("model\tarmor");
        renderer("head", pony.head);
        renderers("ear", pony.extHead);
        renderer("chest", pony.Body);
        renderer("back", pony.Bodypiece);
        renderer("saddle", pony.extBody);
        renderer("frontRight", pony.RightArm);
        renderer("frontLeft", pony.LeftArm);
        renderer("frontRight.top", pony.RightShoulder);
        renderer("frontLeft.top", pony.LeftShoulder);
        renderer("hindRight", pony.RightLeg);
        renderer("hindLeft", pony.LeftLeg);
        renderer("hindRight.joint", pony.RightLegJoint);
        renderer("hindLeft.joint", pony.LeftLegJoint);
        renderer("hindRight.ext", pony.extLegs[0]);
        renderer("hindLeft.ext", pony.extLegs[1]);
        renderer("hindRight.extJoint", pony.extLegs[2]);
        renderer("hindLeft.extJoint", pony.extLegs[3]);
        renderers("hindRight", pony.RightSubLeg);
        renderers("hindLeft", pony.LeftSubLeg);
    }

    public static void main(String[] args) throws ReflectiveOperationException {
        capture(false);
        capture(true);
        captureArmor();
    }
}
